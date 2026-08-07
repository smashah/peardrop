import { Command, Flags } from "@oclif/core";
import { BridgeServer, DiskSink, resolveTargetLocation } from "@peardrop/core/node";
import { runEffect } from "@peardrop/core/node";
import { DropSpecError, parseDropSpecToml, specNeedsDirectoryTarget, type DropSpec } from "@peardrop/core";
import * as Effect from "effect/Effect";
import open from "open";
import { readFileSync } from "node:fs";

// process.stdout.write to a pipe is async on POSIX; awaiting the write
// callback here guarantees the Drop URL is flushed before any subsequent
// await (e.g. opening a browser) can stall the event loop and delay it
// reaching an agent reading the other end of the pipe.
const writeStdout = (line: string): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(line.endsWith("\n") ? line : `${line}\n`, (err) => (err ? reject(err) : resolve()));
  });

export default class LocalCommand extends Command {
  static override description = "Drop files/secrets directly to a local target path (Mode 3, no tunnel/network)";

  static override flags = {
    target: Flags.string({ char: "t", description: "Target destination path", default: "./peardrop-inbox/" }),
    files: Flags.integer({ description: "Expected file count limit" }),
    "max-size": Flags.integer({ description: "Maximum total payload size in MB" }),
    pin: Flags.boolean({ description: "Require PIN code" }),
    lan: Flags.boolean({ description: "Bind 0.0.0.0 for LAN access" }),
    json: Flags.boolean({ description: "Output JSON result" }),
    spec: Flags.string({ description: "Path to a TOML drop-page spec file", exclusive: ["spec-inline"] }),
    "spec-inline": Flags.string({ description: "Inline TOML drop-page spec", exclusive: ["spec"] }),
    "on-receive": Flags.string({ description: "Command to run after a successful drop (overrides [hooks] on_receive)" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(LocalCommand);

    // Malformed/invalid specs fail here, before any server starts.
    let spec: DropSpec | undefined;
    const specSource = flags["spec-inline"] ?? (flags.spec ? readFileSync(flags.spec, "utf-8") : undefined);
    if (specSource !== undefined) {
      try {
        spec = parseDropSpecToml(specSource);
      } catch (cause) {
        const message = cause instanceof DropSpecError ? cause.message : cause instanceof Error ? cause.message : String(cause);
        this.error(message, { exit: 1 });
      }
      if (spec && specNeedsDirectoryTarget(spec) && !flags.target.endsWith("/") && !flags.target.endsWith("\\")) {
        this.error(
          `Spec "${flags.target}" needs a directory target (multiple fields/files would collide on one path) — pass --target with a trailing slash.`,
          { exit: 1 }
        );
      }
    }

    // The flag wins over the spec so a caller can override a checked-in spec's hook.
    const onReceiveCommand = flags["on-receive"] ?? spec?.hooks.on_receive;
    if (onReceiveCommand !== undefined && onReceiveCommand.trim().length === 0) {
      this.error("--on-receive needs a non-empty command.", { exit: 1 });
    }

    const host = flags.lan ? "0.0.0.0" : "127.0.0.1";
    const sink = new DiskSink(flags.target);

    const bridge = new BridgeServer({
      host,
      sink,
      targetPathLabel: flags.target,
      maxSizeMB: flags["max-size"],
      expectedFiles: flags.files,
      spec,
      onReceive: onReceiveCommand
        ? { command: onReceiveCommand, targetPath: resolveTargetLocation(flags.target).basePath }
        : undefined,
    });

    const { url, port, token } = await bridge.start();

    if (flags.json) {
      // Single-line, compact JSON so a piped/agent consumer can read one
      // line and parse it immediately instead of waiting for a multi-line
      // pretty-printed block to arrive in full.
      await writeStdout(JSON.stringify({ mode: "local", event: "listening", url, port, token, target: flags.target, pid: process.pid }));
    } else {
      await writeStdout("\n=========================================");
      await writeStdout(` PearDrop Local Mode (Mode 3 - No Tunnel)`);
      await writeStdout(` Target path: ${flags.target}`);
      await writeStdout(` Drop URL: ${url}`);
      if (flags.lan) {
        await writeStdout(` LAN mode active (trusted networks only)`);
      }
      await writeStdout("=========================================\n");
    }

    if (!flags.json) {
      await Effect.runPromise(
        Effect.tryPromise({
          try: () => open(url),
          catch: () => new Error(`Open in browser: ${url}`),
        }).pipe(Effect.match({ onFailure: (error) => Effect.promise(() => writeStdout(error.message)), onSuccess: () => undefined }))
      );
    }

    const awaitSignal = Effect.callback<"signal">((resume) => {
      const onSignal = () => resume(Effect.succeed("signal"));
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      return Effect.sync(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      });
    });
    const outcome = await runEffect(Effect.raceFirst(bridge.awaitCompletion(), awaitSignal));
    await bridge.stop();

    const status = outcome === "signal" ? "cancelled" : outcome;
    const hook = bridge.hookResult();
    if (flags.json) {
      await writeStdout(JSON.stringify({
        mode: "local",
        event: "closed",
        status,
        target: flags.target,
        pid: process.pid,
        ...(hook ? { hook: { ok: hook.ok, exitCode: hook.exitCode, signal: hook.signal, error: hook.error } } : {}),
      }));
    } else {
      await writeStdout(` Session closed: ${status}`);
      if (hook) await writeStdout(` on_receive hook: ${hook.ok ? "ok" : `failed (${hook.error ?? `exit ${hook.exitCode ?? hook.signal}`})`}`);
    }

    // Signals are already handled above (the drop server stops cleanly), so
    // exit 0 with a summary line rather than letting the process fall
    // through to the default signal-terminated exit code.
    process.exitCode = 0;
  }
}
