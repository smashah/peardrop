import { Args, Command, Flags } from "@oclif/core";
import { loadSession, runEffect } from "@peardrop/core/node";
import { readFileSync } from "node:fs";
import { describeReceiverEvent, isProcessAlive, parseReceiverEvents, TERMINAL_EVENTS } from "../detachLog.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default class WaitCommand extends Command {
  static override description = "Follow a detached receiver until it delivers, expires, or fails (prints its events)";

  static override args = {
    tunnelId: Args.string({ description: "Tunnel ID / slug from receive --detach", required: true }),
  };

  static override flags = {
    json: Flags.boolean({ description: "Print the receiver's JSON events verbatim" }),
    timeout: Flags.string({ description: "Give up after this long (e.g. 10m); default waits until the receiver ends" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WaitCommand);
    const session = await runEffect(loadSession(args.tunnelId));
    if (!session) this.error(`No session for ${args.tunnelId}.`, { exit: 1 });
    if (!session.logPath) this.error(`${args.tunnelId} was not started with receive --detach, so there is no event log to follow.`, { exit: 1 });

    const match = flags.timeout ? /^(\d+)([smhd])$/.exec(flags.timeout) : null;
    if (flags.timeout && !match) this.error("--timeout must look like 30s, 10m, 1h, or 1d.", { exit: 1 });
    const budgetMs = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2]!] ?? 1) * 1000 : Infinity;
    const deadline = Date.now() + budgetMs;

    let seen = 0;
    let deadSince: number | undefined;
    for (;;) {
      let events = [] as ReturnType<typeof parseReceiverEvents>;
      try {
        events = parseReceiverEvents(readFileSync(session.logPath, "utf8"));
      } catch {
        // log not created yet
      }
      for (const event of events.slice(seen)) {
        this.log(flags.json ? event.line : describeReceiverEvent(event));
        if (TERMINAL_EVENTS.has(event.event)) {
          const ok = event.event === "teardown" && event.data.status === "complete";
          return this.exit(ok || event.data.status === "expired" ? 0 : 1);
        }
      }
      seen = events.length;
      if (!isProcessAlive(session.pid)) {
        deadSince ??= Date.now();
        if (Date.now() - deadSince > 1_000) this.error(`Receiver process ${session.pid ?? "?"} is gone without a terminal event; see ${session.logPath}.`, { exit: 1 });
      }
      if (Date.now() > deadline) this.error(`Timed out after ${flags.timeout}; the receiver is still running (pid ${session.pid ?? "?"}).`, { exit: 2 });
      await sleep(250);
    }
  }
}
