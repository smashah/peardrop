import { pruneStaleSessions, runEffect } from "@peardrop/core/node";

/**
 * Sweeps dead session files before a command touches `~/.peardrop/tunnels`, so
 * a receiver that was SIGKILLed or slept through its expiry stops accumulating
 * (smashah/peardrop#106). Housekeeping must never cost a drop: failures are
 * swallowed, and nothing is written to stdout so `--json` stays parseable — the
 * one-line note goes to stderr, and only when the caller asked to be verbose.
 */
export async function pruneSessionsQuietly(options: { readonly verbose?: boolean } = {}): Promise<void> {
  try {
    const { pruned } = await runEffect(pruneStaleSessions());
    if (options.verbose && pruned > 0) {
      process.stderr.write(`[peardrop] pruned ${pruned} stale session file${pruned === 1 ? "" : "s"}\n`);
    }
  } catch {
    // An unreadable sessions directory is not a reason to refuse a drop.
  }
}
