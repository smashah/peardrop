import DHT from "hyperdht";
import type { Duplex } from "node:stream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TransportError } from "../effect/errors.js";
import {
  DonePayloadSchema,
  ErrPayloadSchema,
  FileEndPayloadSchema,
  FrameType,
  ManifestPayloadSchema,
  PdwpCodec,
  PdwpFrameParser,
} from "../protocol/pdwp.js";
import type { HelloPayload } from "../protocol/pdwp.js";
import type { BridgeSink } from "../bridge/BridgeServer.js";

export interface DhtKeyPair {
  readonly publicKey: Buffer;
  readonly secretKey: Buffer;
  readonly publicKeyHex: string;
}

export function createKeyPair(seed?: Buffer): DhtKeyPair {
  const keyPair = seed ? DHT.keyPair(seed) : DHT.keyPair();
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    publicKeyHex: keyPair.publicKey.toString("hex"),
  };
}

export interface ReceiverOptions {
  readonly keyPair: DhtKeyPair;
  readonly sink: BridgeSink;
  readonly onConnected?: () => void;
  readonly onReady?: () => void;
  readonly onDelivered?: (files: ReadonlyArray<unknown>) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly pin?: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

const waitForAbort = (signal?: AbortSignal) =>
  Effect.callback<void, TransportError>((resume) => {
    if (!signal || signal.aborted) {
      resume(Effect.void);
      return;
    }
    signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });

export const runDhtReceiver = (options: ReceiverOptions) =>
  Effect.gen(function* () {
    const dht = yield* Effect.acquireRelease(
      Effect.sync(() => new DHT()),
      (node) =>
        Effect.tryPromise({
          try: () => node.destroy(),
          catch: () => new TransportError({ message: "DHT shutdown failed" }),
        }).pipe(Effect.orElseSucceed(() => undefined))
    );

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        dht.createServer((socket: Duplex) => {
          void handleIncomingSocket(socket, options.sink, options.onConnected, options.onDelivered, options);
        })
      ),
      (srv) =>
        Effect.tryPromise({
          try: () => srv.close(),
          catch: () => new TransportError({ message: "DHT server close failed" }),
        }).pipe(Effect.orElseSucceed(() => undefined))
    );

    yield* Effect.tryPromise({
      try: () => server.listen(options.keyPair),
      catch: (cause) => new TransportError({ message: `DHT listen failed: ${String(cause)}` }),
    });
    options.onReady?.();

    yield* waitForAbort(options.signal);
  });

function handleIncomingSocket(
  socket: Duplex,
  sink: BridgeSink,
  onConnected?: () => void,
  onDelivered?: (files: ReadonlyArray<unknown>) => Promise<void>,
  options: Pick<ReceiverOptions, "pin" | "maxFiles" | "maxBytes"> = {}
): void {
  const parser = new PdwpFrameParser();
  let helloReceived = false;
  let manifest: Schema.Schema.Type<typeof ManifestPayloadSchema> | undefined;
  let nextFileIndex = 0;

  const callSink = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: (cause) => new TransportError({ message: String(cause) }) });
  const decoded = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: (cause) => new TransportError({ message: `Malformed PDWP frame: ${String(cause)}` }) });
  const fail = (error: Error) =>
    writeFrame(socket, PdwpCodec.encodeJsonFrame(FrameType.ERR, { code: "UNKNOWN", message: error.message })).pipe(
      Effect.andThen(callSink(() => sink.onError(error))),
      Effect.ensuring(Effect.sync(() => socket.end()))
    );
  const process = (chunk: Buffer): Effect.Effect<void, TransportError> =>
    Effect.gen(function* () {
      const frames = yield* Effect.try({ try: () => parser.append(chunk), catch: (cause) => new TransportError({ message: String(cause) }) });
      for (const frame of frames) {
        if (frame.type === FrameType.HELLO) {
          const hello = yield* decoded(() => Schema.decodeUnknownSync(Schema.Struct({ v: Schema.Literal(1), pin: Schema.optional(Schema.String) }))(frame.payload));
          if (hello.v !== 1 || helloReceived || (options.pin && hello.pin !== options.pin)) return yield* Effect.fail(new TransportError({ message: "Invalid PDWP HELLO or PIN" }));
          helloReceived = true;
        } else if (frame.type === FrameType.MANIFEST) {
          if (!helloReceived || manifest) return yield* Effect.fail(new TransportError({ message: "PDWP MANIFEST must follow HELLO exactly once" }));
          const payload = yield* decoded(() => Schema.decodeUnknownSync(ManifestPayloadSchema)(frame.payload));
          if (payload.files.length === 0 || !Number.isSafeInteger(payload.totalBytes) || payload.totalBytes < 0 || payload.files.some((file) => !Number.isSafeInteger(file.bytes) || file.bytes < 0) || (options.maxFiles && payload.files.length > options.maxFiles) || (options.maxBytes && payload.totalBytes > options.maxBytes) || payload.totalBytes !== payload.files.reduce((total, file) => total + file.bytes, 0)) return yield* Effect.fail(new TransportError({ message: "PDWP manifest exceeds receiver limits" }));
          manifest = payload;
          onConnected?.();
          yield* callSink(() => sink.onStart(payload.kind, payload.files));
          yield* writeFrame(socket, PdwpCodec.encodeJsonFrame(FrameType.ACCEPT, { ok: true }));
        } else if (frame.type === FrameType.FILE) {
          if (!manifest) return yield* Effect.fail(new TransportError({ message: "PDWP FILE received before MANIFEST" }));
          if (!isFileChunk(frame.payload)) {
            return yield* Effect.fail(new TransportError({ message: "Malformed PDWP file chunk" }));
          }
          const { fileIndex: idx, offset, chunk: data } = frame.payload;
          if (idx !== nextFileIndex) return yield* Effect.fail(new TransportError({ message: "PDWP files must be transferred in manifest order" }));
          yield* callSink(() => sink.onChunk(idx, offset, data));
        } else if (frame.type === FrameType.FILE_END) {
          if (!manifest) return yield* Effect.fail(new TransportError({ message: "PDWP FILE_END received before MANIFEST" }));
          const { fileIndex: idx, sha256 } = yield* decoded(() => Schema.decodeUnknownSync(FileEndPayloadSchema)(frame.payload));
          if (idx !== nextFileIndex) return yield* Effect.fail(new TransportError({ message: "PDWP FILE_END is out of order" }));
          if (sha256 !== manifest.files[idx]?.sha256) return yield* Effect.fail(new TransportError({ message: "PDWP FILE_END hash does not match manifest" }));
          yield* callSink(() => sink.onFileEnd(idx, sha256));
          nextFileIndex += 1;
          if (nextFileIndex === manifest.files.length) {
            const files = yield* callSink(() => sink.onDone());
            if (onDelivered) yield* callSink(() => onDelivered(files));
            yield* writeFrame(socket, PdwpCodec.encodeJsonFrame(FrameType.DONE, { ok: true, files }));
            socket.end();
          }
        } else if (frame.type === FrameType.DONE) {
          return yield* Effect.fail(new TransportError({ message: "PDWP DONE is receiver-to-sender only" }));
        } else if (frame.type === FrameType.ERR) {
          const { message } = yield* decoded(() => Schema.decodeUnknownSync(ErrPayloadSchema)(frame.payload));
          yield* callSink(() => sink.onError(new Error(message ?? "Remote receiver rejected PDWP transfer")));
          yield* Effect.sync(() => socket.end());
        }
      }
    });
  socket.on("data", (chunk: Buffer) => {
    socket.pause();
    Effect.runFork(
      process(chunk).pipe(
        Effect.catchTag("TransportError", fail),
        Effect.ensuring(Effect.sync(() => socket.resume()))
      )
    );
  });
  socket.on("error", (cause) => {
    Effect.runFork(fail(new TransportError({ message: `DHT socket error: ${String(cause)}` })));
  });
}

const writeFrame = (socket: Duplex, frame: Buffer) =>
  Effect.callback<void, TransportError>((resume) => {
    const cleanup = () => { socket.removeListener("drain", onDrain); socket.removeListener("error", onError); };
    const onDrain = () => { cleanup(); resume(Effect.void); };
    const onError = (cause: unknown) => { cleanup(); resume(Effect.fail(new TransportError({ message: String(cause) }))); };
    if (socket.write(frame)) {
      resume(Effect.void);
      return;
    }
    socket.once("drain", onDrain);
    socket.once("error", onError);
  });

const decodeManifest = (payload: unknown) => {
  try {
    return Schema.decodeUnknownSync(ManifestPayloadSchema)(payload);
  } catch (cause) {
    throw new TransportError({ message: `Malformed PDWP frame: ${String(cause)}` });
  }
};

const decodeFileEnd = (payload: unknown) => {
  try {
    return Schema.decodeUnknownSync(FileEndPayloadSchema)(payload);
  } catch (cause) {
    throw new TransportError({ message: `Malformed PDWP frame: ${String(cause)}` });
  }
};

const decodeDone = (payload: unknown) => {
  try {
    return Schema.decodeUnknownSync(DonePayloadSchema)(payload);
  } catch (cause) {
    throw new TransportError({ message: `Malformed PDWP frame: ${String(cause)}` });
  }
};

const decodeError = (payload: unknown) => {
  try {
    return Schema.decodeUnknownSync(ErrPayloadSchema)(payload);
  } catch (cause) {
    throw new TransportError({ message: `Malformed PDWP frame: ${String(cause)}` });
  }
};

const isFileChunk = (payload: unknown): payload is { fileIndex: number; offset: number; chunk: Buffer } =>
  typeof payload === "object" &&
  payload !== null &&
  "fileIndex" in payload &&
  typeof payload.fileIndex === "number" &&
  "offset" in payload &&
  typeof payload.offset === "number" &&
  "chunk" in payload &&
  Buffer.isBuffer(payload.chunk);

export interface SenderConnectOptions {
  readonly publicKeyHex: string;
}

export const connectDhtSender = (options: SenderConnectOptions) =>
  Effect.gen(function* () {
    const dht = yield* Effect.acquireRelease(
      Effect.sync(() => new DHT()),
      (node) =>
        Effect.tryPromise({
          try: () => node.destroy(),
          catch: () => new TransportError({ message: "DHT shutdown failed" }),
        }).pipe(Effect.orElseSucceed(() => undefined))
    );

    const remoteKey = Buffer.from(options.publicKeyHex.replace(/^0x/i, ""), "hex");
    const socket = yield* Effect.sync(() => dht.connect(remoteKey) as Duplex);

    return {
      socket,
      close: () => {
        socket.destroy();
      },
    };
  });
