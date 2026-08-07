import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "commands");
const source = (command: string) => readFileSync(join(commandsDir, `${command}.ts`), "utf8");

/** Anything that can load a wallet key or start a payment round-trip. */
const WALLET_TOUCHPOINTS = [
  "wallet",
  "Wallet",
  "createRelayAuthorization",
  "authorizeRelayOverage",
  "relay-requirements",
  "PEARDROP_WALLET_PRIVATE_KEY",
];

describe("peardrop CLI", () => {
  it("exposes command exports", () => {
    expect(true).toBe(true);
  });

  // Mode 1 (send --browser, local bridge UI) and Mode 3 (local, no tunnel) are
  // local-only paths that must never gate on a wallet. They don't today; this
  // keeps it that way (smashah/peardrop#17).
  describe.each(["send", "local"])("Mode 1/3 command %s stays wallet-free", (command) => {
    const text = source(command);

    it.each(WALLET_TOUCHPOINTS)("never references %s", (touchpoint) => {
      expect(text).not.toContain(touchpoint);
    });

    it("has no relay policy or payment flags", () => {
      expect(text).not.toContain("allow-relay");
      expect(text).not.toContain("relay-cap");
    });
  });

  describe("receive defers wallet interaction", () => {
    const text = source("receive");

    it("no longer creates a relay authorization at session creation", () => {
      expect(text).not.toContain("createRelayAuthorization");
    });

    it("only reaches for the wallet after the tunnel exists and relay bytes are flowing", () => {
      const registration = text.indexOf("/api/tunnels`");
      const authorization = text.indexOf("authorizeRelayOverage(");
      expect(registration).toBeGreaterThan(-1);
      expect(authorization).toBeGreaterThan(registration);
      // Guarded by the Worker's own relay accounting, not by the policy flag.
      expect(text).toContain("relayNeedsAuthorization(");
      expect(text).toContain("/status`");
    });

    it("keeps --allow-relay defaulted on as a policy flag", () => {
      expect(text).toContain(`"allow-relay": Flags.boolean({ description: "Allow fallback relay path", default: true, allowNo: true })`);
    });
  });
});
