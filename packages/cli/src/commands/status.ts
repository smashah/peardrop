import { Command, Flags, Args } from "@oclif/core";
import { loadSession, runEffect } from "@peardrop/core/node";

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

    const local = await runEffect(loadSession(args.tunnelId));

    let remote: { status: string; expiresAt: number; relayBytes: number; relayBytesBilled?: number } | null = null;
    if (local?.ownerToken) {
      const res = await fetch(`${workerUrl}/api/tunnels/${args.tunnelId}/status`, { headers: { Authorization: `Bearer ${local.ownerToken}` } });
      if (res.ok) remote = await res.json() as { status: string; expiresAt: number; relayBytes: number; relayBytesBilled?: number };
      else this.error(`Worker status request failed with HTTP ${res.status}.`);
    }

    const status = remote?.status || local?.status || "unknown";
    const output = {
      tunnelId: args.tunnelId,
      status,
      local,
      remoteReachable: remote !== null,
      consumed: remote === null && local === null,
    };

    if (flags.json) {
      this.log(JSON.stringify(output, null, 2));
    } else if (local) {
      this.log(`Tunnel ${args.tunnelId}: ${status} (Target: ${local.target})`);
    } else if (remote) {
      this.log(`Tunnel ${args.tunnelId}: active on worker`);
    } else {
      this.log(`Tunnel ${args.tunnelId}: Unknown or expired`);
    }
  }
}
