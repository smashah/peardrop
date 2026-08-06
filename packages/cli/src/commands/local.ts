import { Command, Flags } from "@oclif/core";
import { BridgeServer, DiskSink } from "@peardrop/core/node";
import { runEffect } from "@peardrop/core/node";
import * as Effect from "effect/Effect";
import open from "open";

export default class LocalCommand extends Command {
  static override description = "Drop files/secrets directly to a local target path (Mode 3, no tunnel/network)";

  static override flags = {
    target: Flags.string({ char: "t", description: "Target destination path", default: "./peardrop-inbox/" }),
    files: Flags.integer({ description: "Expected file count limit" }),
    "max-size": Flags.integer({ description: "Maximum total payload size in MB" }),
    pin: Flags.boolean({ description: "Require PIN code" }),
    lan: Flags.boolean({ description: "Bind 0.0.0.0 for LAN access" }),
    json: Flags.boolean({ description: "Output JSON result" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(LocalCommand);

    const host = flags.lan ? "0.0.0.0" : "127.0.0.1";
    const sink = new DiskSink(flags.target);

    const bridge = new BridgeServer({
      host,
      sink,
      targetPathLabel: flags.target,
      maxSizeMB: flags["max-size"],
      expectedFiles: flags.files,
    });

    const { url, port, token } = await bridge.start();

    if (flags.json) {
      this.log(JSON.stringify({ mode: "local", url, port, token, target: flags.target }, null, 2));
    } else {
      this.log("\n=========================================");
      this.log(` PearDrop Local Mode (Mode 3 - No Tunnel)`);
      this.log(` Target path: ${flags.target}`);
      this.log(` Drop URL: ${url}`);
      if (flags.lan) {
        this.log(` LAN mode active (trusted networks only)`);
      }
      this.log("=========================================\n");
    }

    if (!flags.json) {
      await Effect.runPromise(
        Effect.tryPromise({
          try: () => open(url),
          catch: () => new Error(`Open in browser: ${url}`),
        }).pipe(Effect.match({ onFailure: (error) => this.log(error.message), onSuccess: () => undefined }))
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
    await runEffect(Effect.raceFirst(bridge.awaitCompletion(), awaitSignal));
    await bridge.stop();
  }
}
