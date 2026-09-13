import { Command, Args, Flags } from "@oclif/core";
import { loadSession, updateSessionStatus, removeSession, runEffect } from "@peardrop/core/node";
import * as Effect from "effect/Effect";
import { isProcessAlive } from "../detachLog.js";

export default class CancelCommand extends Command {
  static override description = "Cancel an active PearDrop tunnel";

  static override args = {
    tunnelId: Args.string({ description: "Tunnel ID / slug to cancel", required: true }),
  };

  static override flags = {
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CancelCommand);
    const workerUrl = flags["worker-url"].replace(/\/$/, "");

    const session = await runEffect(loadSession(args.tunnelId));

    if (session?.ownerToken && session.ownerToken !== "local-only") {
        const response = await fetch(`${workerUrl}/api/tunnels/${args.tunnelId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.ownerToken}` },
        });
        if (!response.ok) this.error(`Remote tunnel cancellation failed with HTTP ${response.status}; local session remains active.`);
    }

    const removed = await runEffect(
      Effect.gen(function* () {
        const updated = yield* updateSessionStatus(args.tunnelId, "cancelled");
        if (updated) return true;
        return yield* removeSession(args.tunnelId);
      })
    );

    if (session?.pid && isProcessAlive(session.pid)) {
      // A detached receiver tears itself down on SIGTERM (Worker DELETE, session status, teardown event).
      try {
        process.kill(session.pid, "SIGTERM");
        this.log(`Stopped background receiver (pid ${session.pid}).`);
      } catch (error) {
        this.warn(`Could not stop receiver pid ${session.pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (removed) {
      this.log(`Tunnel ${args.tunnelId} cancelled.`);
    } else {
      this.log(`Tunnel ${args.tunnelId} not found.`);
    }
  }
}
