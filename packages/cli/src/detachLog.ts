// Liveness lives in core now, so the session sweeper and the CLI agree on what
// "the receiver is gone" means; re-exported here because every command that
// reads a detached log already imports it from this module.
export { isProcessAlive } from "@peardrop/core/node";

/** Parsing for a detached receiver's log: its --json stdout plus any stderr chatter, one line each. */
export interface ReceiverEvent {
  readonly event: string;
  readonly line: string;
  readonly data: Record<string, unknown>;
}

export const TERMINAL_EVENTS = new Set(["teardown", "error"]);
export const SHARE_EVENTS = new Set(["share_ready", "share_pending"]);

/** Returns the JSON event lines in `text`, ignoring partial trailing lines and non-JSON stderr. */
export function parseReceiverEvents(text: string): ReceiverEvent[] {
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const events: ReceiverEvent[] = [];
  for (const line of complete.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      if (typeof data.event === "string") events.push({ event: data.event, line, data });
    } catch {
      // stderr or a torn write; skip
    }
  }
  return events;
}

/** Human one-liner for an event, for callers not in --json mode. Never includes secrets: the stream carries none. */
export function describeReceiverEvent({ event, data }: ReceiverEvent): string {
  switch (event) {
    case "session": return `session registered: ${String(data.url)} (fingerprint ${String(data.fingerprint)})`;
    case "share_ready": return `share_ready: ${String(data.url)} fingerprint ${String(data.fingerprint)}${data.pin ? ` PIN ${String(data.pin)}` : ""} — share this now`;
    case "share_pending": return `share_pending: ${String(data.reason ?? "worker has not confirmed the tunnel yet")}`;
    case "connected": return `sender connected via ${String(data.transport)}`;
    case "delivered": return `delivered ${Array.isArray(data.files) ? data.files.length : "?"} file(s)`;
    case "teardown": return `teardown: ${String(data.status)}${data.reason ? ` (${String(data.reason)})` : ""}`;
    case "error": return `error: ${String(data.error)}`;
    default: return `${event}`;
  }
}
