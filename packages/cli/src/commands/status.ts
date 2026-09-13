import { Command, Flags, Args } from "@oclif/core";
import { loadSession, runEffect } from "@peardrop/core/node";
import { readFileSync } from "node:fs";
import { isProcessAlive, parseReceiverEvents } from "../detachLog.js";
import { pruneSessionsQuietly } from "../pruneSessions.js";

export default class StatusCommand extends Command {
  static override description = "Check status of a PearDrop tunnel";

  static override args = {
    tunnelId: Args.string({ description: "Tunnel ID / slug", required: true }),
  };

  static override flags = {
    json: Flags.boolean({ description: "Output JSON" }),
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(StatusCommand);
    const workerUrl = flags["worker-url"].replace(/\/$/, "");

    // Cheap, and it keeps the directory honest: asking about one session is a
    // fine moment to drop the ones whose receivers are never coming back.
    await pruneSessionsQuietly();

    const local = await runEffect(loadSession(args.tunnelId));

    let remote: { status: string; expiresAt: number; relayBytes: number; relayBytesBilled?: number } | null = null;
    if (local?.ownerToken) {
      const res = await fetch(`${workerUrl}/api/tunnels/${args.tunnelId}/status`, { headers: { Authorization: `Bearer ${local.ownerToken}` } });
      if (res.ok) remote = await res.json() as { status: string; expiresAt: number; relayBytes: number; relayBytesBilled?: number };
      else this.error(`Worker status request failed with HTTP ${res.status}.`);
    }

    const status = remote?.status || local?.status || "unknown";
    const running = isProcessAlive(local?.pid);
    let lastEvent: string | undefined;
    if (local?.logPath) {
      try {
        lastEvent = parseReceiverEvents(readFileSync(local.logPath, "utf8")).at(-1)?.event;
      } catch {
        // no log yet
      }
    }
    const output = {
      tunnelId: args.tunnelId,
      status,
      // `local` carries ownerToken, the receiver's management credential —
      // JSON.stringify drops undefined-valued keys, so this keeps it out of
      // `status --json` output without a second, drifting session shape
      // (smashah/peardrop#86).
      local: local ? { ...local, ownerToken: undefined } : null,
      remoteReachable: remote !== null,
      consumed: remote === null && local === null,
      receiver: { pid: local?.pid, running, lastEvent, logPath: local?.logPath },
    };

    if (flags.json) {
      this.log(JSON.stringify(output, null, 2));
    } else if (local) {
      this.log(`Tunnel ${args.tunnelId}: ${status} (Target: ${local.target})${local.pid ? ` receiver pid ${local.pid} ${running ? "running" : "not running"}` : ""}${lastEvent ? ` last event ${lastEvent}` : ""}`);
    } else if (remote) {
      this.log(`Tunnel ${args.tunnelId}: active on worker`);
    } else {
      this.log(`Tunnel ${args.tunnelId}: Unknown or expired`);
    }
  }
}
