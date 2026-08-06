import { Command, Flags } from "@oclif/core";
import {
  generateFingerprint,
  DiskSink,
  createKeyPair,
  runDhtReceiver,
  runEffect,
  createRelayAuthorization,
  saveSession,
  updateSessionStatus,
  type TunnelSession,
} from "@peardrop/core/node";
import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";

export default class ReceiveCommand extends Command {
  static override description = "Start a P2P receiver session to accept files or secrets";

  static override flags = {
    target: Flags.string({ char: "t", description: "Target directory or file path", default: "./peardrop-inbox/" }),
    files: Flags.integer({ description: "Maximum expected file count" }),
    "max-size": Flags.integer({ description: "Maximum payload size in MB" }),
    ttl: Flags.string({ description: "Tunnel TTL (e.g. 30s, 1h, 24h, 7d)", default: "1h" }),
    pin: Flags.boolean({ description: "Require a 6-digit PIN" }),
    "allow-relay": Flags.boolean({ description: "Allow fallback relay path", default: true, allowNo: true }),
    "relay-cap": Flags.integer({ description: "Relay transfer cap in GB", default: 2 }),
    json: Flags.boolean({ description: "Output JSON metadata" }),
    name: Flags.string({ description: "Optional tunnel label" }),
    detach: Flags.boolean({ description: "Run receiver in background" }),
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ReceiveCommand);

    const keySeed = randomBytes(32);
    const keyPair = createKeyPair(keySeed);
    const fingerprint = generateFingerprint(keyPair.publicKeyHex);
    const pinCode = flags.pin ? Math.floor(100000 + Math.random() * 900000).toString() : undefined;

    let ttlSec = 3600;
    if (flags.ttl.endsWith("s")) ttlSec = parseInt(flags.ttl, 10);
    else if (flags.ttl.endsWith("m")) ttlSec = parseInt(flags.ttl, 10) * 60;
    else if (flags.ttl.endsWith("h")) ttlSec = parseInt(flags.ttl, 10) * 3600;
    else if (flags.ttl.endsWith("d")) ttlSec = parseInt(flags.ttl, 10) * 86400;

    const workerUrl = flags["worker-url"].replace(/\/$/, "");

    let relayAuthorization: unknown;
    let allowRelay = flags["allow-relay"];
    if (allowRelay) {
      const authorization = await runEffect(Effect.exit(createRelayAuthorization(workerUrl, flags["relay-cap"])));
      if (Exit.isSuccess(authorization)) {
        relayAuthorization = authorization.value;
      } else {
        const error = Cause.squash(authorization.cause);
        const message = error instanceof Error ? error.message : "Relay authorization failed";
        if (message.includes("requirements unavailable with HTTP 503")) {
          allowRelay = false;
          this.warn("Relay payment is unavailable on this Worker network; creating a direct-only tunnel.");
        } else {
          this.error(`Relay authorization could not be created: ${message}. Use --no-allow-relay for direct-only.`);
        }
      }
    }

    if (flags.detach) {
      this.error("--detach is unavailable until supervised receiver persistence is implemented; run receive in the foreground.");
    }

    let tunnelRes: {
      slug: string;
      url: string;
      ownerToken: string;
      relayAllowed: boolean;
    };

    try {
      const res = await fetch(`${workerUrl}/api/tunnels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: keyPair.publicKeyHex,
          fingerprint,
          expectedFiles: flags.files,
          maxSizeMB: flags["max-size"],
          ttlSeconds: ttlSec,
          pin: pinCode,
          allowRelay,
          relayCapGB: flags["relay-cap"],
          relayAuthorization,
          label: flags.name,
        }),
      });
      if (!res.ok) {
        throw new Error(`Worker registration failed with HTTP ${res.status}`);
      }
      tunnelRes = await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Worker tunnel registration failed: ${message}. No public PearDrop URL was created.`);
    }

    const tunnelState: TunnelSession = {
      tunnelId: tunnelRes.slug,
      url: tunnelRes.url,
      fingerprint,
      pin: pinCode,
      target: flags.target,
      expiresAt: Date.now() + ttlSec * 1000,
      relayAllowed: tunnelRes.relayAllowed ?? flags["allow-relay"],
      ownerToken: tunnelRes.ownerToken,
      workerUrl,
      mode: "remote",
      status: "waiting",
    };

    await runEffect(saveSession(tunnelState));

    if (flags.json) {
      this.log(JSON.stringify(tunnelState, null, 2));
    } else {
      this.log("\n=========================================");
      this.log(` PearDrop Receiver Active`);
      this.log(` URL: ${tunnelState.url}`);
      this.log(` Fingerprint: ${fingerprint}`);
      if (pinCode) this.log(` PIN required: ${pinCode}`);
      this.log(` Target path: ${flags.target}`);
      this.log(` Relay path: ${tunnelState.relayAllowed ? "Enabled (Max $0.06)" : "Disabled (Direct-only)"}`);
      this.log("=========================================\n");
      this.log("Waiting for sender connection...");
    }

    const abort = new AbortController();
    const onSignal = () => abort.abort();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const sink = new DiskSink(flags.target);

    try {
      await runEffect(
        Effect.scoped(runDhtReceiver({
          keyPair,
          sink,
          signal: abort.signal,
          pin: pinCode,
          maxFiles: flags.files,
          maxBytes: flags["max-size"] ? flags["max-size"] * 1024 * 1024 : undefined,
          onConnected: () => {
            if (!flags.json) this.log("Sender connected — receiving payload...");
          },
          onDelivered: async (files) => {
            await runEffect(updateSessionStatus(tunnelState.tunnelId, "waiting", {
              files: files as TunnelSession["files"],
            }));
            const consumption = await fetch(`${workerUrl}/api/tunnels/${tunnelState.tunnelId}/consumed`, {
              method: "POST",
              headers: { Authorization: `Bearer ${tunnelState.ownerToken}` },
            });
            if (!consumption.ok) {
              throw new Error(`Worker delivery confirmation failed with HTTP ${consumption.status}`);
            }
            await runEffect(updateSessionStatus(tunnelState.tunnelId, "delivered"));
            if (!flags.json) this.log("Payload delivered successfully.");
          },
        })),
        { signal: abort.signal }
      );
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}
