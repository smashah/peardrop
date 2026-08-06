import { Command, Flags, Args } from "@oclif/core";
import { BridgeServer, PdwpSink, connectDhtSender, runEffect } from "@peardrop/core/node";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { open as openFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import open from "open";

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
    relay: Flags.string({ description: "Custom relay URL override" }),
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SendCommand);

    const slug = args.targetUrl.includes("/") ? args.targetUrl.split("/").pop()! : args.targetUrl;
    const workerUrl = flags["worker-url"].replace(/\/$/, "");

    const descriptor = await runEffect(Effect.tryPromise({
      try: async (): Promise<{ publicKey?: string; label?: string; maxSizeMB?: number; expectedFiles?: number } | null> => {
        const res = await fetch(`${workerUrl}/api/tunnels/${slug}`);
        return res.ok ? await res.json() : null;
      },
      catch: () => new Error("Tunnel descriptor unavailable"),
    }).pipe(Effect.orElseSucceed(() => null)));

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
          const dhtSender = yield* connectDhtSender({ publicKeyHex: publicKey });
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
          command.log(`Delivered ${received.length} file(s) after receiver confirmation.`);
        })
      )
    );
  }
}
