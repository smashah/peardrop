import { Command, Flags } from "@oclif/core";
import {
  generateFingerprint,
  DiskSink,
  createKeyPair,
  runDhtReceiver,
  runEffect,
  authorizeRelayOverage,
  relayNeedsAuthorization,
  RELAY_FREE_TIER_BYTES,
  WalletError,
  saveSession,
  updateSessionStatus,
  resolveTargetLocation,
  runOnReceiveHook,
  type TunnelSession,
} from "@peardrop/core/node";
import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";

/**
 * How often the receiver asks the Worker how many bytes it has relayed. Polling
 * backs off while nothing is being relayed — a tunnel can idle for its whole TTL
 * — and snaps back to the fast interval as soon as relay bytes appear.
 */
const RELAY_USAGE_POLL_MS = 3_000;
const RELAY_USAGE_POLL_MAX_MS = 30_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

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
    "on-receive": Flags.string({ description: "Command to run after a successful drop" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ReceiveCommand);

    const onReceiveCommand = flags["on-receive"];
    if (onReceiveCommand !== undefined && onReceiveCommand.trim().length === 0) {
      this.error("--on-receive needs a non-empty command.", { exit: 1 });
    }

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

    // --allow-relay is a policy flag only: it grants permission to fall back to
    // the relay, and never triggers a wallet load or a payment round-trip here.
    // Relay is free up to RELAY_FREE_TIER_BYTES, so authorization is deferred
    // until the Worker reports relayed bytes trending over that threshold.
    const allowRelay = flags["allow-relay"];

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
      const freeTierMB = RELAY_FREE_TIER_BYTES / (1024 * 1024);
      this.log(
        ` Relay path: ${tunnelState.relayAllowed ? `Enabled (free up to ${freeTierMB}MB, then metered — max $0.06)` : "Disabled (Direct-only)"}`
      );
      this.log("=========================================\n");
      this.log("Waiting for sender connection...");
    }

    const abort = new AbortController();
    const onSignal = () => abort.abort();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    // Lazy relay authorization. The Worker's own relay accounting is the only
    // honest signal that direct P2P did not carry the transfer, so poll it and
    // reach for the wallet exactly once relayed bytes trend over the free tier.
    // Below that threshold no wallet is loaded and the Worker is never asked
    // for payment requirements.
    let relayAuthorizationFailure: string | undefined;
    const watchRelayOverage = async (): Promise<void> => {
      if (!tunnelState.relayAllowed || !tunnelState.ownerToken) return;
      let pollMs = RELAY_USAGE_POLL_MS;
      while (!abort.signal.aborted && !relayAuthorizationFailure) {
        await sleep(pollMs, abort.signal);
        if (abort.signal.aborted) return;

        let relayBytes: number;
        try {
          const status = await fetch(`${workerUrl}/api/tunnels/${tunnelState.tunnelId}/status`, {
            headers: { Authorization: `Bearer ${tunnelState.ownerToken}` },
            signal: abort.signal,
          });
          if (!status.ok) continue;
          const body = (await status.json()) as { relayBytes?: number };
          relayBytes = typeof body.relayBytes === "number" ? body.relayBytes : 0;
        } catch {
          continue;
        }
        pollMs = relayBytes > 0 ? RELAY_USAGE_POLL_MS : Math.min(pollMs * 2, RELAY_USAGE_POLL_MAX_MS);
        if (!relayNeedsAuthorization(relayBytes)) continue;

        const authorization = await runEffect(
          Effect.exit(authorizeRelayOverage({ workerUrl, relayCapGb: flags["relay-cap"], relayBytes }))
        );
        if (Exit.isFailure(authorization)) {
          const error = Cause.squash(authorization.cause);
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof WalletError && error.userActionable) {
            relayAuthorizationFailure = message;
            abort.abort();
          } else {
            // A Worker- or facilitator-side problem is not something the
            // operator can fix mid-transfer, so keep receiving and say so.
            this.warn(`Relay payment authorization is unavailable (${message}); the transfer continues but relay usage may not be billable.`);
          }
          return;
        }
        if (authorization.value === null) continue;

        // Hand the signed "upto" authorization to the Worker so it can settle
        // the real byte count. Workers that predate deferred authorization
        // (peardrop.fyi#20) reject this route — warn rather than interrupt an
        // in-flight transfer.
        const submitted = await fetch(`${workerUrl}/api/tunnels/${tunnelState.tunnelId}/relay-authorization`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tunnelState.ownerToken}` },
          body: JSON.stringify({ relayAuthorization: authorization.value, relayCapGB: flags["relay-cap"] }),
        }).catch(() => undefined);
        if (!submitted?.ok) {
          this.warn(
            `Relay usage passed the free tier but this Worker did not accept the deferred payment authorization (HTTP ${submitted?.status ?? "unreachable"}); the transfer continues but may not be billable.`
          );
        } else if (!flags.json) {
          this.log("Relay usage passed the free tier — payment authorization signed and submitted.");
        }
        return;
      }
    };
    void watchRelayOverage().catch(() => undefined);

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

            // Side effect only: a failing hook is reported, never rolled back into
            // the delivery that already completed above.
            if (onReceiveCommand) {
              const hook = await runOnReceiveHook({
                command: onReceiveCommand,
                targetPath: resolveTargetLocation(flags.target).basePath,
                files: files as ReadonlyArray<{ name: string; path?: string }>,
              });
              if (!flags.json) this.log(`on_receive hook: ${hook.ok ? "ok" : `failed (${hook.error ?? `exit ${hook.exitCode ?? hook.signal}`})`}`);
            }
          },
        })),
        { signal: abort.signal }
      );
    } catch (error) {
      // An abort this command raised itself (relay overage with no wallet) is
      // reported below with an actionable message, not as a fiber interrupt.
      if (!relayAuthorizationFailure) throw error;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      abort.abort();
    }

    // The only point at which a missing wallet is an error: relay was actually
    // used, past the free tier, and nothing can pay for it.
    if (relayAuthorizationFailure) {
      this.error(relayAuthorizationFailure);
    }
  }
}
