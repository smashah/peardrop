import { Command, Flags, Args } from "@oclif/core";
import { BridgeServer, PdwpSink, connectDhtSender, runEffect } from "@peardrop/core/node";
import {
  RelaySenderError,
  sendRelay,
  type RelayFile,
  type RelayLifecycleEvent,
  type RelayWebSocket,
} from "@peardrop/core";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { open as openFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import * as Effect from "effect/Effect";
import open from "open";
import WebSocket from "ws";

const PDWP_CHUNK_BYTES = 64 * 1024;

export default class SendCommand extends Command {
  static override description = "Send files or secrets to a PearDrop link";

  static override args = {
    targetUrl: Args.string({ description: "PearDrop link or slug", required: true }),
    files: Args.string({ description: "Files to send", required: false }),
  };

  static override flags = {
    browser: Flags.boolean({ char: "b", description: "Open local bridge UI in browser (Mode 1)" }),
    text: Flags.string({ description: "Text/secret to send" }),
    pin: Flags.string({ description: "Receiver PIN when the tunnel requires one" }),
    relay: Flags.boolean({ description: "Force the production WebSocket Relay transport" }),
    verbose: Flags.boolean({ char: "v", description: "Write phase diagnostics to stderr" }),
    json: Flags.boolean({ description: "Write structured lifecycle events to stdout" }),
    "non-custodial-only": Flags.boolean({ hidden: true, description: "Disable custodial Relay fallback" }),
    "relay-timeout-ms": Flags.integer({ hidden: true, default: 30_000 }),
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi" }),
  };

  public async run(): Promise<void> {
    const startedAt = performance.now();
    const { args, flags } = await this.parse(SendCommand);

    const slug = args.targetUrl.includes("/") ? args.targetUrl.split("/").pop()! : args.targetUrl;
    const workerUrl = flags["worker-url"].replace(/\/$/, "");

    const descriptorStartedAt = performance.now();
    const writeJson = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
    const writeVerbose = (source: "sender" | "relay", value: { readonly phase: string; readonly elapsedMs: number; readonly status?: string; readonly attempt?: number; readonly mode?: string; readonly reason?: string; readonly error?: string }) => {
      if (!flags.verbose) return;
      const details = [
        `elapsedMs=${value.elapsedMs}`,
        `pid=${process.pid}`,
        `phase=${value.phase}`,
        value.attempt === undefined ? undefined : `attempt=${value.attempt}`,
        value.mode === undefined ? undefined : `mode=${value.mode}`,
        value.status === undefined ? undefined : `status=${value.status}`,
        value.reason === undefined ? undefined : `reason=${value.reason}`,
        value.error === undefined ? undefined : `error=${value.error}`,
      ].filter((part): part is string => part !== undefined);
      process.stderr.write(`[${source}] ${details.join(" ")}\n`);
    };
    const descriptorStartEvent = { event: "sender", phase: "descriptor-fetch", status: "start", elapsedMs: 0, pid: process.pid } as const;
    if (flags.json) writeJson(descriptorStartEvent);
    writeVerbose("sender", descriptorStartEvent);
    const descriptor = await runEffect(Effect.tryPromise({
      try: async (): Promise<{ publicKey?: string; label?: string; maxSizeMB?: number; expectedFiles?: number } | null> => {
        const res = await fetch(`${workerUrl}/api/tunnels/${slug}`);
        return res.ok ? await res.json() : null;
      },
      catch: () => new Error("Tunnel descriptor unavailable"),
    }).pipe(Effect.orElseSucceed(() => null)));
    const descriptorCompletedAt = performance.now();
    const descriptorMs = Math.round(descriptorCompletedAt - startedAt);
    const descriptorEvent = { event: "sender", phase: "descriptor-fetch", status: "complete", elapsedMs: descriptorMs, durationMs: Math.round(descriptorCompletedAt - descriptorStartedAt), pid: process.pid } as const;
    if (flags.json) writeJson(descriptorEvent);
    writeVerbose("sender", descriptorEvent);

    if (flags.browser || (!args.files && !flags.text)) {
      if (!descriptor?.publicKey) {
        this.error("Tunnel descriptor missing publicKey — cannot open direct bridge. Is the receiver running?");
      }

      this.log("Starting PearDrop Local Bridge (Mode 1)...");
      const command = this;

      await runEffect(Effect.scoped(Effect.gen(function* () {
        const dhtSender = yield* connectDhtSender({ publicKeyHex: descriptor.publicKey! });
        const bridge = new BridgeServer({
          sink: new PdwpSink(dhtSender.socket, flags.pin),
          targetPathLabel: descriptor.label || `Tunnel ${slug}`,
          maxSizeMB: descriptor.maxSizeMB,
          expectedFiles: descriptor.expectedFiles,
        });
        const { url } = yield* Effect.tryPromise({ try: () => bridge.start(), catch: () => new Error("Bridge start failed") });
        command.log(`\nLocal Bridge URL: ${url}`);
        command.log("Opening browser drop interface...");
        yield* Effect.tryPromise({ try: () => open(url), catch: () => new Error(`Could not auto-open browser. Please visit: ${url}`) }).pipe(Effect.match({ onFailure: (error) => command.log(error.message), onSuccess: () => undefined }));
        const awaitSignal = Effect.callback<"signal">((resume) => {
          const onSignal = () => resume(Effect.succeed("signal"));
          process.once("SIGINT", onSignal);
          process.once("SIGTERM", onSignal);
          return Effect.sync(() => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          });
        });
        const outcome = yield* Effect.raceFirst(bridge.awaitCompletion(), awaitSignal);
        yield* Effect.tryPromise({ try: () => bridge.stop(), catch: () => new Error("Bridge shutdown failed") });
        command.log(`Bridge session ${outcome}.`);
      })));
      return;
    }

    if (!descriptor?.publicKey) {
      this.error("Tunnel descriptor missing publicKey — cannot start a direct transfer.");
    }
    const publicKey = descriptor?.publicKey;
    if (!publicKey) return;
    const filePath = args.files;
    if (!filePath && !flags.text) {
      this.error("Specify a file path or use --browser for the local drop surface.");
      return;
    }

    if (flags.relay) {
      const relayFile: RelayFile = flags.text
        ? {
            name: "pasted-secret.txt",
            size: Buffer.byteLength(flags.text, "utf8"),
            stream: () => {
              const payload = new TextEncoder().encode(flags.text);
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(payload);
                  controller.close();
                },
              });
            },
          }
        : yieldFile(filePath!, await stat(filePath!));
      try {
        const result = await runEffect(Effect.scoped(sendRelay({
          descriptor: { slug, publicKey },
          files: [relayFile],
          workerUrl,
          pin: flags.pin,
          fallback: flags["non-custodial-only"] ? "none" : "custodial",
          acceptTimeoutMs: flags["relay-timeout-ms"],
          onEvent: (event) => {
            const adjusted = { ...event, elapsedMs: descriptorMs + event.elapsedMs, pid: process.pid, transport: "relay" as const };
            if (flags.json) writeJson(adjusted);
            writeVerbose("relay", adjusted);
          },
        }, {
          fetch,
          createWebSocket: (url) => new WebSocket(url) as unknown as RelayWebSocket,
        })));
        const totalMs = Math.round(performance.now() - startedAt);
        const delivered = { event: "delivered", transport: "relay", mode: result.mode, files: result.files, elapsedMs: totalMs, pid: process.pid } as const;
        if (flags.json) writeJson(delivered);
        else this.log(`Delivered ${result.files.length} file(s) via Relay (${result.mode}) in ${totalMs}ms.`);
        return;
      } catch (cause) {
        const failure = cause instanceof RelaySenderError
          ? { event: "error", transport: "relay", phase: cause.phase, attempt: cause.attempt, mode: cause.mode, error: cause.message, elapsedMs: Math.round(performance.now() - startedAt), pid: process.pid }
          : { event: "error", transport: "relay", phase: "unknown", error: cause instanceof Error ? cause.message : String(cause), elapsedMs: Math.round(performance.now() - startedAt), pid: process.pid };
        if (flags.json) writeJson(failure);
        writeVerbose("relay", { ...failure, status: "failed" });
        this.error(`Relay send failed at ${failure.phase}: ${failure.error}`);
      }
    }
    const command = this;
    await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const file = flags.text
            ? undefined
            : yield* Effect.acquireRelease(
                Effect.tryPromise({ try: () => openFile(filePath!, "r"), catch: () => new Error(`Could not open ${filePath}`) }),
                (handle) => Effect.tryPromise({ try: () => handle.close(), catch: () => new Error(`Could not close ${filePath}`) }).pipe(Effect.orElseSucceed(() => undefined))
              );
          const content = flags.text ? Buffer.from(flags.text, "utf8") : undefined;
          const name = flags.text ? "pasted-secret.txt" : basename(filePath!);
          const digest = createHash("sha256");
          let totalBytes = content?.length ?? 0;
          if (file) {
            let position = 0;
            while (true) {
              const buffer = Buffer.allocUnsafe(PDWP_CHUNK_BYTES);
              const read = yield* Effect.tryPromise({ try: () => file.read(buffer, 0, buffer.length, position), catch: () => new Error(`Could not read ${filePath}`) });
              if (read.bytesRead === 0) break;
              digest.update(buffer.subarray(0, read.bytesRead));
              totalBytes += read.bytesRead;
              position += read.bytesRead;
            }
          } else if (content) digest.update(content);
          const sha256 = digest.digest("hex");
          const prepareMs = Math.round(performance.now() - descriptorCompletedAt);
          const dhtSender = yield* connectDhtSender({ publicKeyHex: publicKey });
          const endpoint = dhtSender.details.remoteHost && dhtSender.details.remotePort
            ? ` endpoint=${dhtSender.details.remoteHost}:${dhtSender.details.remotePort}`
            : "";
          const connectedLine = `Connected — transport=${dhtSender.details.transport}${endpoint} peer=${dhtSender.details.remotePublicKey} dhtConnectMs=${dhtSender.details.dhtConnectMs}`;
          if (flags.json) writeJson({ event: "connected", ...dhtSender.details, elapsedMs: Math.round(performance.now() - startedAt), pid: process.pid });
          else if (flags.verbose) process.stderr.write(`[sender] elapsedMs=${Math.round(performance.now() - startedAt)} pid=${process.pid} phase=dht-connect transport=${dhtSender.details.transport} dhtConnectMs=${dhtSender.details.dhtConnectMs}\n`);
          else command.log(connectedLine);
          const transferStartedAt = performance.now();
          const sink = new PdwpSink(dhtSender.socket, flags.pin);
          yield* Effect.tryPromise({ try: () => sink.onStart("files", [{ name, bytes: totalBytes, sha256 }]), catch: () => new Error("Receiver did not accept the PDWP manifest") });
          if (content) {
            yield* Effect.tryPromise({ try: () => sink.onChunk(0, 0, content), catch: () => new Error("PDWP text transfer failed") });
          } else if (file) {
            let position = 0;
            while (position < totalBytes) {
              const buffer = Buffer.allocUnsafe(Math.min(PDWP_CHUNK_BYTES, totalBytes - position));
              const read = yield* Effect.tryPromise({ try: () => file.read(buffer, 0, buffer.length, position), catch: () => new Error(`Could not read ${filePath}`) });
              if (read.bytesRead === 0) return yield* Effect.fail(new Error("File changed while preparing PDWP transfer"));
              const chunk = buffer.subarray(0, read.bytesRead);
              yield* Effect.tryPromise({ try: () => sink.onChunk(0, position, chunk), catch: () => new Error("PDWP file transfer failed") });
              position += read.bytesRead;
            }
          }
          yield* Effect.tryPromise({ try: () => sink.onFileEnd(0, sha256), catch: () => new Error("PDWP file finalization failed") });
          const received = yield* Effect.tryPromise({ try: () => sink.onDone(), catch: () => new Error("Receiver did not acknowledge delivery") });
          const transferMs = Math.round(performance.now() - transferStartedAt);
          const totalMs = Math.round(performance.now() - startedAt);
          if (flags.json) writeJson({ event: "delivered", transport: dhtSender.details.transport, files: received, descriptorMs, prepareMs, dhtConnectMs: dhtSender.details.dhtConnectMs, transferMs, totalMs, elapsedMs: totalMs, pid: process.pid });
          else if (flags.verbose) process.stderr.write(`[sender] elapsedMs=${totalMs} pid=${process.pid} phase=done transport=${dhtSender.details.transport} status=complete descriptorMs=${descriptorMs} prepareMs=${prepareMs} dhtConnectMs=${dhtSender.details.dhtConnectMs} transferMs=${transferMs} totalMs=${totalMs}\n`);
          else command.log(`Delivered ${received.length} file(s) after receiver confirmation — descriptorMs=${descriptorMs} prepareMs=${prepareMs} dhtConnectMs=${dhtSender.details.dhtConnectMs} transferMs=${transferMs} totalMs=${totalMs}.`);
        })
      )
    );
  }
}

const yieldFile = (path: string, details: { readonly size: number }): RelayFile => ({
  name: basename(path),
  size: details.size,
  stream: () => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
});
