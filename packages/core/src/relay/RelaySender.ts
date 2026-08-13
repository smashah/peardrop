import DHT, { Stream } from "./dhtRelayRuntime.js";
import type { WebSocketLike } from "@hyperswarm/dht-relay/ws";
import { sha256 } from "@noble/hashes/sha256";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

const CHUNK_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ACCEPT_POLL_MS = 5_000;
const ACCEPT_TIMEOUT_MESSAGE = "Receiver did not ACCEPT the relay manifest in time";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

enum FrameType {
  HELLO = 1,
  MANIFEST = 2,
  ACCEPT = 3,
  FILE = 4,
  FILE_END = 5,
  DONE = 6,
  ERR = 7,
}

export type RelayMode = "non-custodial" | "custodial-fallback";
export type RelayFallback = "custodial" | "none";
export type RelayFallbackReason =
  | "accept-timeout"
  | "dht-connect-failed"
  | "pre-accept-connection-failed";
export type RelayPhase =
  | "ticket-request"
  | "socket-open"
  | "dht-connect"
  | "hashing"
  | "hello"
  | "manifest"
  | "accept"
  | "bytes"
  | "file-end"
  | "done"
  | "teardown"
  | "fallback";

export interface RelayLifecycleEvent {
  readonly event: "relay";
  readonly attempt: number;
  readonly mode: RelayMode;
  readonly phase: RelayPhase;
  readonly status: "start" | "progress" | "complete" | "failed";
  readonly elapsedMs: number;
  readonly durationMs?: number;
  readonly fileIndex?: number;
  readonly fileCount?: number;
  readonly bytesSent?: number;
  readonly totalBytes?: number;
  readonly waitedMs?: number;
  readonly timeoutMs?: number;
  readonly reason?: RelayFallbackReason;
  readonly error?: string;
}

export class RelaySenderError extends Data.TaggedError("RelaySenderError")<{
  readonly message: string;
  readonly phase: RelayPhase;
  readonly attempt: number;
  readonly mode: RelayMode;
  readonly connectionFailure?: boolean;
  readonly beforeReceiverAccept?: boolean;
}> {}

export const isRelayConnectionFailure = (error: unknown): boolean =>
  error instanceof RelaySenderError && error.connectionFailure === true;

export interface RelayDescriptor {
  readonly slug: string;
  readonly publicKey: string;
}

export interface RelayFile {
  readonly name: string;
  readonly stream: () => ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface RelayWebSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array | ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: unknown) => void,
    options?: { readonly once?: boolean }
  ): void;
  removeEventListener(type: "open" | "close" | "error" | "message", listener: (event: unknown) => void): void;
}

export interface RelaySenderAdapters {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly createWebSocket: (url: string) => RelayWebSocket;
  readonly now?: () => number;
}

export interface RelaySendRequest {
  readonly descriptor: RelayDescriptor;
  readonly files: ReadonlyArray<RelayFile>;
  readonly workerUrl?: string;
  readonly pin?: string;
  readonly fallback?: RelayFallback;
  readonly acceptTimeoutMs?: number;
  readonly acceptPollMs?: number;
  readonly onEvent?: (event: RelayLifecycleEvent) => void;
}

export interface RelaySendResult {
  readonly files: ReadonlyArray<{ readonly name: string; readonly bytes: number; readonly sha256: string; readonly path?: string }>;
  readonly mode: RelayMode;
}

const RelayTicketSchema = Schema.Struct({
  ticket: Schema.NonEmptyString,
  relayUrl: Schema.NonEmptyString,
  billingScheme: Schema.Literal("upto"),
  region: Schema.optional(Schema.NonEmptyString),
});
const DoneSchema = Schema.Struct({
  ok: Schema.Literal(true),
  files: Schema.Array(Schema.Struct({
    name: Schema.NonEmptyString,
    bytes: Schema.Number,
    sha256: Schema.NonEmptyString,
    path: Schema.optional(Schema.String),
  })),
});
const ErrSchema = Schema.Struct({ code: Schema.String, message: Schema.optional(Schema.String) });

const concat = (...chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const frame = (type: FrameType, payload: Uint8Array) => {
  const output = new Uint8Array(payload.byteLength + 5);
  new DataView(output.buffer).setUint32(0, payload.byteLength + 1, true);
  output[4] = type;
  output.set(payload, 5);
  return output;
};
const jsonFrame = (type: FrameType, value: unknown) => frame(type, encoder.encode(JSON.stringify(value)));
const fileFrame = (fileIndex: number, offset: number, chunk: Uint8Array) => {
  const header = new Uint8Array(10);
  const view = new DataView(header.buffer);
  view.setUint16(0, fileIndex, true);
  view.setBigUint64(2, BigInt(offset), true);
  return frame(FrameType.FILE, concat(header, chunk));
};

const hexToBytes = (hex: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("Tunnel public key is invalid");
  }
  return Uint8Array.from(Array.from(
    { length: 32 },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  ));
};

const write = (
  socket: {
    write: (data: Uint8Array) => boolean;
    once: (event: string, listener: (cause?: unknown) => void) => void;
    removeListener: (event: string, listener: (cause?: unknown) => void) => void;
  },
  data: Uint8Array,
  error: RelaySenderError
) => Effect.suspend(() => {
  if (socket.write(data)) return Effect.void;
  return Effect.callback<void, RelaySenderError>((resume) => {
    const cleanup = () => {
      socket.removeListener("drain", onDrain);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = () => {
      cleanup();
      resume(Effect.fail(error));
    };
    const onClose = () => {
      cleanup();
      resume(Effect.fail(error));
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
    return Effect.sync(cleanup);
  });
});

const withTimeout = <A, E>(effect: Effect.Effect<A, E>, durationMs: number, error: RelaySenderError) =>
  Effect.timeoutOrElse(effect, {
    duration: Duration.millis(durationMs),
    orElse: () => Effect.fail(error),
  });

const hashFile = (file: RelayFile, error: RelaySenderError) => Effect.suspend(() => {
    const digest = sha256.create();
    const reader = file.stream().getReader();
    let completed = false;
    const read = Effect.callback<ReadableStreamReadResult<Uint8Array>, RelaySenderError>((resume) => {
      let active = true;
      void reader.read().then(
        (result) => {
          if (active) resume(Effect.succeed(result));
        },
        () => {
          if (active) resume(Effect.fail(error));
        }
      );
      return Effect.sync(() => {
        active = false;
      });
    });
    return Effect.gen(function* () {
      while (true) {
        const next = yield* read;
        if (next.done) break;
        digest.update(next.value);
      }
      completed = true;
      return Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }).pipe(Effect.ensuring(Effect.gen(function* () {
      if (!completed) {
        yield* Effect.tryPromise({
          try: () => reader.cancel("Relay hashing stopped before the input stream completed"),
          catch: () => undefined,
        }).pipe(Effect.ignore);
      }
      yield* Effect.sync(() => reader.releaseLock());
    })));
});

type AttemptContext = {
  readonly attempt: number;
  readonly mode: RelayMode;
  readonly startedAt: number;
  readonly now: () => number;
  readonly onEvent?: (event: RelayLifecycleEvent) => void;
};

const report = (context: AttemptContext, event: Omit<RelayLifecycleEvent, "event" | "attempt" | "mode" | "elapsedMs">) =>
  Effect.sync(() => context.onEvent?.({
    event: "relay",
    attempt: context.attempt,
    mode: context.mode,
    elapsedMs: Math.max(0, Math.round(context.now() - context.startedAt)),
    ...event,
  }));

const runPhase = <A>(
  context: AttemptContext,
  phase: RelayPhase,
  effect: Effect.Effect<A, RelaySenderError>
) => Effect.gen(function* () {
  const phaseStartedAt = context.now();
  yield* report(context, { phase, status: "start" });
  const exit = yield* Effect.exit(effect);
  const durationMs = Math.max(0, Math.round(context.now() - phaseStartedAt));
  if (Exit.isSuccess(exit)) {
    yield* report(context, { phase, status: "complete", durationMs });
    return exit.value;
  }
  const found = Exit.findError(exit);
  const message = found._tag === "Success" ? found.success.message : `Relay ${phase} failed`;
  yield* report(context, { phase, status: "failed", durationMs, error: message });
  return yield* exit;
});

const attemptTransferScoped = (
  request: RelaySendRequest,
  adapters: RelaySenderAdapters,
  context: AttemptContext,
  custodial: boolean
) => Effect.gen(function* () {
  let receiverAccepted = false;
  const failure = (phase: RelayPhase, message: string, connectionFailure = true) =>
    new RelaySenderError({
      message,
      phase,
      attempt: context.attempt,
      mode: context.mode,
      connectionFailure,
      beforeReceiverAccept: !receiverAccepted,
    });
  const timeoutMs = request.acceptTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = request.acceptPollMs ?? DEFAULT_ACCEPT_POLL_MS;

  const ticket = yield* runPhase(context, "ticket-request", Effect.tryPromise({
    try: async () => {
      const workerUrl = request.workerUrl?.replace(/\/$/, "") ?? "";
      const response = await adapters.fetch(`${workerUrl}/api/tunnels/${request.descriptor.slug}/relay-ticket`, { method: "POST" });
      if (!response.ok) throw new Error(`Relay ticket request failed with HTTP ${response.status}`);
      return Schema.decodeUnknownSync(RelayTicketSchema)(await response.json());
    },
    catch: (cause) => failure("ticket-request", cause instanceof Error ? cause.message : "Relay ticket request failed"),
  }));

  const socket = yield* runPhase(context, "socket-open", withTimeout(
    Effect.callback<RelayWebSocket, RelaySenderError>((resume) => {
      const regionParam = ticket.region ? `&region=${encodeURIComponent(ticket.region)}` : "";
      const webSocket = adapters.createWebSocket(`${ticket.relayUrl}?ticket=${encodeURIComponent(ticket.ticket)}${regionParam}`);
      webSocket.binaryType = "arraybuffer";
      const onOpen = () => {
        cleanup();
        resume(Effect.succeed(webSocket));
      };
      const onError = () => {
        cleanup();
        resume(Effect.fail(failure("socket-open", "Relay WebSocket connection failed")));
      };
      const cleanup = () => {
        webSocket.removeEventListener("open", onOpen);
        webSocket.removeEventListener("error", onError);
      };
      webSocket.addEventListener("open", onOpen, { once: true });
      webSocket.addEventListener("error", onError, { once: true });
      return Effect.sync(() => {
        cleanup();
        webSocket.close();
      });
    }),
    timeoutMs,
    failure("socket-open", "Relay WebSocket connection timed out")
  ));
  yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));

  const transportClosed = yield* Deferred.make<never, string>();
  const onSocketClose = (event: unknown) => {
    const code = typeof (event as { code?: unknown })?.code === "number"
      ? ` (code ${(event as { code: number }).code})`
      : "";
    Effect.runFork(Deferred.fail(transportClosed, `Relay WebSocket closed during transfer${code}`));
  };
  const onSocketError = (event: unknown) => {
    const message = event instanceof Error ? `: ${event.message}` : "";
    Effect.runFork(Deferred.fail(transportClosed, `Relay WebSocket failed during transfer${message}`));
  };
  socket.addEventListener("close", onSocketClose, { once: true });
  socket.addEventListener("error", onSocketError, { once: true });
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    socket.removeEventListener("close", onSocketClose);
    socket.removeEventListener("error", onSocketError);
  }));
  const guardTransport = <A>(phase: RelayPhase, effect: Effect.Effect<A, RelaySenderError>) =>
    Effect.raceFirst(
      effect,
      Deferred.await(transportClosed).pipe(Effect.mapError((message) => failure(phase, message)))
    );

  const stream = new Stream(true, socket as unknown as WebSocketLike);
  const dht = new DHT(stream, { custodial });
  const destroyDht = (dht as typeof dht & { destroy?: () => void }).destroy;
  yield* Effect.addFinalizer(() => Effect.sync(() => destroyDht?.call(dht)));
  const peer = dht.connect(hexToBytes(request.descriptor.publicKey));
  const peerEvents = peer as typeof peer & {
    on(event: "error", listener: (error: unknown) => void): void;
    on(event: "close", listener: () => void): void;
    removeListener(event: "error", listener: (error: unknown) => void): void;
    removeListener(event: "close", listener: () => void): void;
  };
  const accepted = yield* Deferred.make<true, RelaySenderError>();
  const done = yield* Deferred.make<RelaySendResult["files"], RelaySenderError>();
  const peerConnectionFailed = yield* Deferred.make<never, RelaySenderError>();
  let dhtConnected = false;
  const failReceiver = (message: string, phase: RelayPhase, connectionFailure = true) =>
    Deferred.fail(accepted, failure(phase, message, connectionFailure)).pipe(
      Effect.andThen(Deferred.fail(done, failure(phase, message, connectionFailure)))
    );
  const failPeerConnection = (message: string) => {
    const phase: RelayPhase = !dhtConnected ? "dht-connect" : receiverAccepted ? "done" : "accept";
    const error = failure(phase, message);
    Effect.runFork(Deferred.fail(peerConnectionFailed, error).pipe(
      Effect.andThen(Deferred.fail(accepted, error)),
      Effect.andThen(Deferred.fail(done, error))
    ));
  };
  const onPeerError = (cause: unknown) => {
    failPeerConnection(cause instanceof Error ? cause.message : "Relay peer connection failed");
  };
  const onPeerClose = () => {
    failPeerConnection("Relay peer connection closed during transfer");
  };
  peerEvents.on("error", onPeerError);
  peerEvents.on("close", onPeerClose);
  yield* Effect.addFinalizer(() => Effect.sync(() => peer.destroy()));
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    peerEvents.removeListener("error", onPeerError);
    peerEvents.removeListener("close", onPeerClose);
  }));
  const guardPeerConnection = <A>(effect: Effect.Effect<A, RelaySenderError>) =>
    Effect.raceFirst(effect, Deferred.await(peerConnectionFailed));
  const guardConnection = <A>(phase: RelayPhase, effect: Effect.Effect<A, RelaySenderError>) =>
    guardTransport(phase, guardPeerConnection(effect));
  yield* runPhase(context, "dht-connect", withTimeout(
    guardConnection("dht-connect", Effect.tryPromise({
      try: () => peer.opened,
      catch: (cause) => failure("dht-connect", cause instanceof Error ? cause.message : "Relay DHT connection failed"),
    }).pipe(Effect.flatMap((opened) => opened
      ? Effect.void
      : Effect.fail(failure("dht-connect", "Relay DHT connection closed before opening"))))),
    timeoutMs,
    failure("dht-connect", "Relay DHT connection timed out")
  ));
  dhtConnected = true;

  let received: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const processIncoming = (chunk: Uint8Array) => Effect.gen(function* () {
    received = concat(received, chunk);
    if (received.byteLength > MAX_BUFFER_BYTES) {
      received = new Uint8Array();
      return yield* failReceiver("Relay PDWP buffer exceeded its maximum size", "done");
    }
    while (received.byteLength >= 5) {
      const length = new DataView(received.buffer, received.byteOffset, received.byteLength).getUint32(0, true);
      if (length < 1 || length > MAX_FRAME_BYTES) {
        received = new Uint8Array();
        return yield* failReceiver("Relay returned an invalid PDWP frame length", "done");
      }
      if (received.byteLength < length + 4) return;
      const type = received[4];
      const payload = received.slice(5, length + 4);
      received = received.slice(length + 4);
      if (type === FrameType.ACCEPT) {
        receiverAccepted = true;
        yield* Deferred.succeed(accepted, true);
      }
      if (type === FrameType.DONE) {
        const json = yield* Effect.try({
          try: () => JSON.parse(decoder.decode(payload)) as unknown,
          catch: () => failure("done", "Receiver returned invalid DONE JSON"),
        });
        const decoded = Schema.decodeUnknownExit(DoneSchema)(json);
        if (decoded._tag === "Success") yield* Deferred.succeed(done, decoded.value.files);
        else return yield* failReceiver("Receiver returned malformed DONE acknowledgement", "done");
      }
      if (type === FrameType.ERR) {
        const json = yield* Effect.try({
          try: () => JSON.parse(decoder.decode(payload)) as unknown,
          catch: () => failure("done", "Receiver returned invalid ERR JSON"),
        });
        const decoded = Schema.decodeUnknownExit(ErrSchema)(json);
        const message = decoded._tag === "Success"
          ? decoded.value.message ?? "Receiver rejected the relay transfer"
          : "Receiver rejected the relay transfer";
        return yield* failReceiver(message, "done", false);
      }
    }
  });
  const incomingFibers = new Set<Fiber.Fiber<boolean | undefined, RelaySenderError>>();
  const onData = (chunk: Uint8Array) => {
    let fiber: Fiber.Fiber<boolean | undefined, RelaySenderError>;
    fiber = Effect.runFork(processIncoming(chunk).pipe(
      Effect.ensuring(Effect.sync(() => incomingFibers.delete(fiber)))
    ));
    incomingFibers.add(fiber);
  };
  peer.on("data", onData);
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* Effect.forEach(incomingFibers, Fiber.interrupt, { discard: true });
    peer.removeListener("data", onData);
  }));
  const boundedWrite = (data: Uint8Array, error: RelaySenderError) =>
    withTimeout(guardConnection(error.phase, write(peer, data, error)), timeoutMs, error);

  const manifests = yield* Effect.forEach(request.files, (file, fileIndex) => runPhase(
    context,
    "hashing",
    guardConnection(
      "hashing",
      hashFile(file, failure("hashing", `Could not hash ${file.name}`, false)).pipe(
        Effect.tap(() => report(context, { phase: "hashing", status: "progress", fileIndex, fileCount: request.files.length })),
        Effect.map((digest) => ({ name: file.name, bytes: file.size, sha256: digest }))
      )
    )
  ));
  yield* runPhase(context, "hello", boundedWrite(
    jsonFrame(FrameType.HELLO, { v: 1, pin: request.pin }),
    failure("hello", "Could not write PDWP HELLO")
  ));
  yield* runPhase(context, "manifest", boundedWrite(
    jsonFrame(FrameType.MANIFEST, {
      files: manifests,
      totalBytes: manifests.reduce((total, file) => total + file.bytes, 0),
      kind: "files",
    }),
    failure("manifest", "Could not write PDWP MANIFEST")
  ));

  yield* runPhase(context, "accept", guardConnection("accept", Effect.gen(function* () {
    const acceptStartedAt = context.now();
    let waitedMs = 0;
    yield* report(context, { phase: "accept", status: "progress", waitedMs, timeoutMs });
    while (waitedMs < timeoutMs) {
      const step = Math.min(pollMs, timeoutMs - waitedMs);
      const outcome = yield* Effect.raceFirst(
        Deferred.await(accepted).pipe(Effect.as("accepted" as const)),
        Effect.sleep(Duration.millis(step)).pipe(Effect.as("waiting" as const))
      );
      if (outcome === "accepted") return;
      waitedMs = Math.min(timeoutMs, Math.max(waitedMs + step, Math.round(context.now() - acceptStartedAt)));
      yield* report(context, { phase: "accept", status: "progress", waitedMs, timeoutMs });
    }
    return yield* Effect.fail(failure("accept", ACCEPT_TIMEOUT_MESSAGE));
  })));

  for (const [fileIndex, file] of request.files.entries()) {
    const reader = file.stream().getReader();
    let offset = 0;
    let readCompleted = false;
    yield* report(context, { phase: "bytes", status: "progress", fileIndex, bytesSent: 0, totalBytes: file.size });
    yield* Effect.gen(function* () {
      while (true) {
        const next = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => failure("bytes", `Could not read ${file.name}`, false),
        });
        if (next.done) break;
        for (let chunkOffset = 0; chunkOffset < next.value.byteLength; chunkOffset += CHUNK_BYTES) {
          const chunk = next.value.slice(chunkOffset, chunkOffset + CHUNK_BYTES);
          yield* boundedWrite(fileFrame(fileIndex, offset, chunk), failure("bytes", `Could not send ${file.name}`));
          offset += chunk.byteLength;
          yield* report(context, { phase: "bytes", status: "progress", fileIndex, bytesSent: offset, totalBytes: file.size });
        }
      }
      readCompleted = true;
    }).pipe(Effect.ensuring(Effect.gen(function* () {
      if (!readCompleted) {
        yield* Effect.tryPromise({
          try: () => reader.cancel("Relay transfer stopped before the input stream completed"),
          catch: () => undefined,
        }).pipe(Effect.ignore);
      }
      yield* Effect.sync(() => reader.releaseLock());
    })));
    if (offset !== manifests[fileIndex]?.bytes) {
      return yield* Effect.fail(failure("bytes", `${file.name} changed while sending`, false));
    }
    yield* runPhase(context, "file-end", boundedWrite(
      jsonFrame(FrameType.FILE_END, { fileIndex, sha256: manifests[fileIndex]?.sha256 }),
      failure("file-end", `Could not finalize ${file.name}`)
    ));
  }

  const delivered = yield* runPhase(context, "done", withTimeout(
    guardConnection("done", Deferred.await(done)),
    timeoutMs,
    failure("done", "Receiver did not confirm delivery in time")
  ));
  return { files: delivered, mode: context.mode };
});

const attemptTransfer = (
  request: RelaySendRequest,
  adapters: RelaySenderAdapters,
  context: AttemptContext,
  custodial: boolean
) => Effect.gen(function* () {
  let teardownStartedAt = context.now();
  const attempt = Effect.scoped(attemptTransferScoped(request, adapters, context, custodial).pipe(
    Effect.ensuring(Effect.suspend(() => {
      teardownStartedAt = context.now();
      return report(context, { phase: "teardown", status: "start" });
    }))
  ));
  const exit = yield* Effect.exit(attempt);
  yield* report(context, {
    phase: "teardown",
    status: "complete",
    durationMs: Math.max(0, Math.round(context.now() - teardownStartedAt)),
  });
  return yield* exit;
});

export const sendRelay = (request: RelaySendRequest, adapters: RelaySenderAdapters) =>
  Effect.gen(function* () {
    if (request.files.length === 0) {
      return yield* Effect.fail(new RelaySenderError({
        message: "Select a file or enter text before sending",
        phase: "hashing",
        attempt: 1,
        mode: "non-custodial",
        connectionFailure: false,
      }));
    }
    const startedAt = (adapters.now ?? performance.now.bind(performance))();
    const now = adapters.now ?? performance.now.bind(performance);
    const firstContext: AttemptContext = {
      attempt: 1,
      mode: "non-custodial",
      startedAt,
      now,
      onEvent: request.onEvent,
    };
    const first = yield* Effect.exit(attemptTransfer(request, adapters, firstContext, false));
    if (Exit.isSuccess(first)) return first.value;
    const found = Exit.findError(first);
    if (found._tag !== "Success" || request.fallback === "none") return yield* first;
    const fallbackReason: RelayFallbackReason | undefined = found.success.phase === "accept"
      && found.success.message === ACCEPT_TIMEOUT_MESSAGE
      ? "accept-timeout"
      : found.success.connectionFailure === true
        && found.success.beforeReceiverAccept === true
        && found.success.phase !== "ticket-request"
        && found.success.phase !== "socket-open"
        ? found.success.phase === "dht-connect"
          ? "dht-connect-failed"
          : "pre-accept-connection-failed"
        : undefined;
    if (!fallbackReason) return yield* first;
    yield* report(firstContext, { phase: "fallback", status: "complete", reason: fallbackReason });
    const fallbackContext: AttemptContext = {
      attempt: 2,
      mode: "custodial-fallback",
      startedAt,
      now,
      onEvent: request.onEvent,
    };
    return yield* attemptTransfer(request, adapters, fallbackContext, true);
  });
