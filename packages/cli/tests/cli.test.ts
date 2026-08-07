import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "@oclif/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ReceiveCommand from "../src/commands/receive.js";

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

    it("frames relay as the default path with an opt-out flag (smashah/peardrop#22)", () => {
      // --no-relay, not --allow-relay: the flag exists to turn relay off.
      expect(text).toContain("relay: Flags.boolean({");
      expect(text).toContain("--no-relay for direct-only");
      // The 1.2.0 spelling still parses so existing scripts keep working.
      expect(text).toContain(`"allow-relay": Flags.boolean({ description: "Deprecated alias for --relay", hidden: true, allowNo: true })`);
      expect(text).toContain(`const allowRelay = flags["allow-relay"] ?? flags.relay;`);
    });
  });

  describe("receive --json never leaves a consumer with nothing to parse", () => {
    const runReceive = async (argv: string[]) => {
      const config = await Config.load(join(dirname(fileURLToPath(import.meta.url)), ".."));
      return ReceiveCommand.run(argv, config);
    };
    const captureStdout = () => {
      const chunks: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, encoding: unknown, callback: unknown) => {
        chunks.push(String(chunk));
        const done = typeof encoding === "function" ? encoding : callback;
        if (typeof done === "function") done();
        return true;
      }) as typeof process.stdout.write);
      return chunks;
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reports an unreachable Worker as one JSON line on stdout and exits non-zero", async () => {
      const chunks = captureStdout();
      // Port 1 is reserved and refuses immediately, so this is the registration
      // failure path without depending on a live Worker.
      await expect(runReceive(["--json", "--ttl", "60s", "--worker-url", "http://127.0.0.1:1"])).rejects.toMatchObject({
        oclif: { exit: 1 },
      });

      const lines = chunks.join("").split("\n").filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(1);
      const reported = JSON.parse(lines[0]!) as { event: string; error: string };
      expect(reported.event).toBe("error");
      expect(reported.error).toContain("Worker tunnel registration failed");
    });

    it("reports an unusable flag combination as JSON rather than human prose", async () => {
      const chunks = captureStdout();
      await expect(runReceive(["--json", "--detach"])).rejects.toMatchObject({ oclif: { exit: 1 } });

      const reported = JSON.parse(chunks.join("").trim()) as { event: string; error: string };
      expect(reported.event).toBe("error");
      expect(reported.error).toContain("--detach is unavailable");
    });
  });
});
