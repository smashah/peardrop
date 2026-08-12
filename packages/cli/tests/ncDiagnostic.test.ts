import { describe, expect, it } from "vitest";
import { parseBoundedTimeout, redactDiagnosticValue } from "../src/diagnostics/nc.js";

describe("test nc diagnostic safety", () => {
  it("redacts session authority and relay admission material recursively", () => {
    expect(redactDiagnosticValue({
      tunnelId: "safe-slug",
      ownerToken: "owner-secret",
      publicKey: "receiver-key",
      nested: { ticket: "relay-ticket", relayUrl: "wss://relay.example" },
    })).toEqual({
      tunnelId: "safe-slug",
      ownerToken: "[REDACTED]",
      publicKey: "[REDACTED]",
      nested: { ticket: "[REDACTED]", relayUrl: "[REDACTED]" },
    });
  });

  it("accepts bounded duration overrides and rejects unbounded diagnostics", () => {
    expect(parseBoundedTimeout("30s")).toBe(30_000);
    expect(parseBoundedTimeout("2m")).toBe(120_000);
    expect(() => parseBoundedTimeout("4s")).toThrow(/between 5s and 2m/);
    expect(() => parseBoundedTimeout("3m")).toThrow(/between 5s and 2m/);
    expect(() => parseBoundedTimeout("forever")).toThrow(/duration/);
  });
});
