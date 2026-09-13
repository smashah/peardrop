import { describe, expect, it } from "vitest";
import { describeReceiverEvent, isProcessAlive, parseReceiverEvents } from "../src/detachLog.js";

describe("detached receiver log", () => {
  it("keeps only complete JSON event lines, ignoring stderr and torn writes", () => {
    const text = 'npm warn something\n{"event":"session","url":"https://x/a","fingerprint":"F"}\n{"event":"share_ready","url":"https://x/a","fingerprint":"F"}\n{"event":"conn';
    const events = parseReceiverEvents(text);
    expect(events.map((e) => e.event)).toEqual(["session", "share_ready"]);
    expect(describeReceiverEvent(events[1]!)).toContain("share this now");
  });

  it("knows whether a pid is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(undefined)).toBe(false);
    expect(isProcessAlive(2 ** 22 - 1)).toBe(false);
  });
});
