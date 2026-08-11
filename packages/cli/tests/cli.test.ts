import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "@oclif/core";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  // peardrop#35: killing this process any way other than `peardrop cancel`
  // left the Worker's tunnel record alive until TTL, so the drop page kept
  // answering 200 with nothing behind it. A real SIGTERM-mid-session
  // end-to-end test needs a DHT-receiver test double this suite doesn't have
  // yet (the other `receive` tests below all fail fast at registration,
  // before the DHT receiver ever starts) — verified live instead (kill a
  // real `receive --relay` session, confirm its tunnel 404s afterward). This
  // is the cheap structural guard against the fix's call being deleted or
  // moved outside the signal-triggered path by accident.
  describe("receive tears its own tunnel down on SIGINT/SIGTERM (peardrop#35)", () => {
    const text = source("receive");

    it("only issues the cancellation DELETE when a signal was actually received", () => {
      const signalFlagSet = text.indexOf("signalReceived = true");
      const finallyBlock = text.indexOf("} finally {");
      const deleteCall = text.indexOf(`method: "DELETE"`);
      expect(signalFlagSet).toBeGreaterThan(-1);
      expect(finallyBlock).toBeGreaterThan(signalFlagSet);
      expect(deleteCall).toBeGreaterThan(finallyBlock);
      expect(text).toContain("if (signalReceived)");
    });

    it("cancels with the same tunnel id and owner token the session was created with", () => {
      expect(text).toContain("`${workerUrl}/api/tunnels/${tunnelState.tunnelId}`");
      expect(text).toContain("Authorization: `Bearer ${tunnelState.ownerToken}`");
    });

    it("doesn't let a failed cancellation call throw past process shutdown", () => {
      // Best-effort: a network blip on the way out must not block the
      // process from exiting, so the DELETE has to be wrapped, not awaited
      // bare.
      const deleteIndex = text.indexOf(`method: "DELETE"`);
      const surroundingTry = text.lastIndexOf("try {", deleteIndex);
      const surroundingCatch = text.indexOf("} catch", deleteIndex);
      expect(surroundingTry).toBeGreaterThan(-1);
      expect(surroundingCatch).toBeGreaterThan(deleteIndex);
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

  describe("receive reports control-plane registration loss", () => {
    const text = source("receive");

    it("stops waiting and emits an actionable error when its live tunnel disappears", () => {
      expect(text).toContain("status.status === 404 || status.status === 410");
      expect(text).toContain("Receiver registration disappeared");
      expect(text).toContain("receiverRegistrationFailure");
      expect(text).toContain("return this.fail(receiverRegistrationFailure, flags.json)");
    });
  });

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

  describe("receive --json never leaves a consumer with nothing to parse", () => {
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

  // smashah/peardrop#26: remote drops were a raw "paste something" box because
  // only `local` could read a TOML spec. The spec now travels with the tunnel
  // registration so the Worker-served page can render it.
  describe("receive --spec", () => {
    const VALID_SPEC = [
      'title = "Rotate the deploy key"',
      'description = "Paste the new key; the old one dies with this link."',
      "",
      "[copy]",
      'request = "Paste the new deploy key below."',
      "",
      "[[fields]]",
      'name = "deploy_key"',
      'type = "secret"',
      'label = "Deploy key"',
      "",
    ].join("\n");

    /** Captures the registration body, then fails the call so the command stops at registration. */
    const captureRegistration = () => {
      const bodies: Array<Record<string, unknown>> = [];
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        throw new Error("registration intentionally stopped by the test");
      }) as typeof fetch);
      return { bodies, spy };
    };

    it("rejects malformed TOML before any request reaches the Worker", async () => {
      const { spy } = captureRegistration();
      const chunks = captureStdout();

      await expect(runReceive(["--json", "--spec-inline", 'title = "unterminated'])).rejects.toMatchObject({
        oclif: { exit: 1 },
      });

      expect(spy).not.toHaveBeenCalled();
      const reported = JSON.parse(chunks.join("").trim()) as { event: string; error: string };
      expect(reported.event).toBe("error");
      expect(reported.error).toContain("Malformed TOML");
    });

    it("rejects a spec whose fields would collide on a single-file target", async () => {
      const { spy } = captureRegistration();
      const chunks = captureStdout();
      const twoFields = `${VALID_SPEC}\n[[fields]]\nname = "account_id"\ntype = "text"\n`;

      await expect(
        runReceive(["--json", "--spec-inline", twoFields, "--target", "./inbox.txt"])
      ).rejects.toMatchObject({ oclif: { exit: 1 } });

      expect(spy).not.toHaveBeenCalled();
      const reported = JSON.parse(chunks.join("").trim()) as { error: string };
      expect(reported.error).toContain("needs a directory target");
    });

    it("sends the parsed spec — defaults applied — in the tunnel registration body", async () => {
      const { bodies } = captureRegistration();
      captureStdout();

      await expect(runReceive(["--json", "--spec-inline", VALID_SPEC])).rejects.toMatchObject({ oclif: { exit: 1 } });

      expect(bodies).toHaveLength(1);
      const spec = bodies[0]!.spec as { title: string; copy: Record<string, string>; fields: Array<Record<string, unknown>> };
      expect(spec.title).toBe("Rotate the deploy key");
      expect(spec.copy.request).toBe("Paste the new deploy key below.");
      // `required` is defaulted by the parser, so the Worker and page never have
      // to re-derive it from an absent key.
      expect(spec.fields).toEqual([
        { name: "deploy_key", type: "secret", label: "Deploy key", required: true },
      ]);
    });

    it("reads the spec from a file, and a spec-defined hook still feeds --on-receive", async () => {
      const { bodies } = captureRegistration();
      captureStdout();
      const specPath = join(tmpdir(), `peardrop-receive-spec-${process.pid}.toml`);
      writeFileSync(specPath, `${VALID_SPEC}\n[hooks]\non_receive = "echo delivered"\n`);

      try {
        await expect(runReceive(["--json", "--spec", specPath])).rejects.toMatchObject({ oclif: { exit: 1 } });
      } finally {
        rmSync(specPath, { force: true });
      }

      const spec = bodies[0]!.spec as { hooks: Record<string, string> };
      expect(spec.hooks.on_receive).toBe("echo delivered");
      expect(source("receive")).toContain(`flags["on-receive"] ?? spec?.hooks.on_receive`);
    });

    it("leaves a no-spec session's registration body exactly as it was", async () => {
      const { bodies } = captureRegistration();
      captureStdout();

      await expect(runReceive(["--json"])).rejects.toMatchObject({ oclif: { exit: 1 } });

      expect(bodies[0]).not.toHaveProperty("spec");
    });
  });
});
