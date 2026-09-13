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
import { DropSpecError, parseDropSpecToml, specNeedsDirectoryTarget, type DropSpec } from "@peardrop/core";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
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

// process.stdout.write to a pipe is async on POSIX, so an unawaited write can
// still be sitting in the buffer when the process exits or is killed. Awaiting
// the callback is what guarantees an agent reading the other end of the pipe
// actually sees the line.
const writeStdout = (line: string): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(line.endsWith("\n") ? line : `${line}\n`, (err) => (err ? reject(err) : resolve()));
  });

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** Total budget for `pollShareReadiness` to confirm `GET /api/tunnels/{slug}` before giving up and reporting `share_pending`. */
export const READINESS_BUDGET_MS = 15_000;
const READINESS_POLL_INITIAL_MS = 250;
const READINESS_POLL_MAX_MS = 2_000;

export type ShareReadiness = "ready" | "pending" | "aborted";

export interface PollShareReadinessOptions {
  readonly fetchTunnel: (signal: AbortSignal) => Promise<{ ok: boolean }>;
  readonly signal: AbortSignal;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly budgetMs?: number;
}

/**
 * Bounded poll for Worker tunnel-registration propagation. Extracted as a
 * pure function (fetch/sleep injected) so its outcomes — resolves
 * immediately, resolves after retries, never resolves in budget, a single
 * request that never settles — are directly unit-testable without a live
 * Worker or a real receiver session.
 *
 * `fetch` has no response timeout of its own: a Worker that accepts the
 * connection and then stalls before sending headers hangs the request
 * indefinitely. Each attempt is therefore bounded to the remaining budget by
 * its own AbortController, distinct from `options.signal` (the receiver's
 * own Ctrl-C/SIGTERM signal) — a budget timeout must resolve to "pending",
 * while the receiver's own signal must resolve to "aborted", and the two are
 * never conflated.
 */
export async function pollShareReadiness(options: PollShareReadinessOptions): Promise<ShareReadiness> {
  const budgetMs = options.budgetMs ?? READINESS_BUDGET_MS;
  const deadline = performance.now() + budgetMs;
  let pollMs = READINESS_POLL_INITIAL_MS;
  while (true) {
    if (options.signal.aborted) return "aborted";
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "pending";

    const requestController = new AbortController();
    const onExternalAbort = () => requestController.abort();
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    // The timer is the authority on its own expiry — re-deriving "budget
    // exhausted" from performance.now() after the abort races the timer
    // itself (setTimeout can fire a fraction of a millisecond before the
    // clock agrees the deadline has passed), which made the number of
    // attempts depend on sub-millisecond rounding. A flag set only by this
    // callback is unambiguous regardless of what the clock says afterward.
    let budgetExpired = false;
    const requestTimer = setTimeout(() => {
      budgetExpired = true;
      requestController.abort();
    }, remaining);
    try {
      const res = await options.fetchTunnel(requestController.signal);
      if (res.ok) return "ready";
    } catch {
      if (options.signal.aborted) return "aborted";
      if (budgetExpired) return "pending";
      // An unrelated transient error — fall through to the budget check
      // below rather than treating it as exhausted.
    } finally {
      clearTimeout(requestTimer);
      options.signal.removeEventListener("abort", onExternalAbort);
    }

    const remainingAfter = deadline - performance.now();
    if (remainingAfter <= 0) return "pending";
    await options.sleep(Math.min(pollMs, remainingAfter), options.signal);
    pollMs = Math.min(pollMs * 2, READINESS_POLL_MAX_MS);
  }
}

export default class ReceiveCommand extends Command {
  static override description = "Start a P2P receiver session to accept files or secrets";

  static override flags = {
    target: Flags.string({ char: "t", description: "Target directory or file path", default: "./peardrop-inbox/" }),
    files: Flags.integer({ description: "Maximum expected file count" }),
    "max-size": Flags.integer({ description: "Maximum payload size in MB" }),
    ttl: Flags.string({ description: "Tunnel TTL (e.g. 1m, 1h, 24h, 7d); expiry emits teardown status=expired and exits 0", default: "1h" }),
    pin: Flags.boolean({ description: "Require a 6-digit PIN" }),
    // Relay is the default path (peardrop#22): the flag exists to turn it off,
    // never to turn it on. `--allow-relay` stays as a hidden alias so scripts
    // written against 1.2.0 — including `--no-allow-relay` — keep working.
    relay: Flags.boolean({
      description: "Use the encrypted relay when a direct connection is impossible (on by default; --no-relay for direct-only)",
      default: true,
      allowNo: true,
    }),
    "allow-relay": Flags.boolean({ description: "Deprecated alias for --relay", hidden: true, allowNo: true }),
    "relay-cap": Flags.integer({ description: "Relay transfer cap in GB", default: 2 }),
    json: Flags.boolean({ description: "Output JSON metadata" }),
    verbose: Flags.boolean({ char: "v", description: "Write phase diagnostics to stderr" }),
    name: Flags.string({ description: "Optional tunnel label" }),
    // Hidden, not removed: #88's accepted resolution is to stop advertising
    // background supervision this CLI doesn't implement, not to implement it.
    detach: Flags.boolean({ description: "Run receiver in background", hidden: true }),
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi" }),
    spec: Flags.string({ description: "Path to a TOML drop-page spec file", exclusive: ["spec-inline"] }),
    "spec-inline": Flags.string({ description: "Inline TOML drop-page spec", exclusive: ["spec"] }),
    "on-receive": Flags.string({ description: "Command to run after a successful drop (overrides [hooks] on_receive)" }),
  };

  /**
   * Terminal failure that a `--json` consumer can actually read. oclif's own
   * error rendering is human-shaped prose on stderr, so a piped agent watching
   * stdout for JSON gets nothing it can parse; emit one JSON line, flushed,
   * and exit non-zero instead.
   */
  private async fail(message: string, json: boolean): Promise<never> {
    if (!json) this.error(message, { exit: 1 });
    await writeStdout(JSON.stringify({ mode: "remote", event: "error", error: message }));
    return this.exit(1);
  }

  public async run(): Promise<void> {
    const startedAt = performance.now();
    const { flags } = await this.parse(ReceiveCommand);
    const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
    const writeVerbose = (phase: string, fields: Readonly<Record<string, string | number | boolean | undefined>> = {}) => {
      if (!flags.verbose) return;
      const details = Object.entries(fields)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`);
      process.stderr.write(`[receiver] elapsedMs=${elapsedMs()} pid=${process.pid} phase=${phase}${details.length > 0 ? ` ${details.join(" ")}` : ""}\n`);
    };

    // Malformed/invalid specs fail here, before the Worker is ever asked for a
    // tunnel — the same fail-fast contract `local` gives before it starts a server.
    let spec: DropSpec | undefined;
    try {
      const specSource = flags["spec-inline"] ?? (flags.spec ? readFileSync(flags.spec, "utf-8") : undefined);
      if (specSource !== undefined) spec = parseDropSpecToml(specSource);
    } catch (cause) {
      const message = cause instanceof DropSpecError ? cause.message : cause instanceof Error ? cause.message : String(cause);
      return this.fail(message, flags.json);
    }
    if (spec && specNeedsDirectoryTarget(spec) && !flags.target.endsWith("/") && !flags.target.endsWith("\\")) {
      return this.fail(
        `This spec needs a directory target (multiple fields/files would collide on "${flags.target}") — pass --target with a trailing slash.`,
        flags.json
      );
    }

    // The flag wins over the spec so a caller can override a checked-in spec's hook.
    const onReceiveCommand = flags["on-receive"] ?? spec?.hooks.on_receive;
    if (onReceiveCommand !== undefined && onReceiveCommand.trim().length === 0) {
      return this.fail("--on-receive needs a non-empty command.", flags.json);
    }

    const keySeed = randomBytes(32);
    const keyPair = createKeyPair(keySeed);
    const fingerprint = generateFingerprint(keyPair.publicKeyHex);
    const pinCode = flags.pin ? Math.floor(100000 + Math.random() * 900000).toString() : undefined;

    const ttlMatch = /^(\d+)([smhd])$/.exec(flags.ttl);
    const ttlSec = ttlMatch
      ? Number(ttlMatch[1]) * (ttlMatch[2] === "d" ? 86400 : ttlMatch[2] === "h" ? 3600 : ttlMatch[2] === "m" ? 60 : 1)
      : NaN;
    if (!Number.isSafeInteger(ttlSec * 1000) || ttlSec <= 0) {
      return this.fail("--ttl must be a positive whole-number duration in range, such as 60s, 5m, 1h, or 7d.", flags.json);
    }

    const workerUrl = flags["worker-url"].replace(/\/$/, "");

    // Relay permission is a policy decision only: it never triggers a wallet
    // load or a payment round-trip here. Relay is free up to
    // RELAY_FREE_TIER_BYTES, so authorization is deferred until the Worker
    // reports relayed bytes trending over that threshold.
    const allowRelay = flags["allow-relay"] ?? flags.relay;

    if (flags.detach) {
      return this.fail(
        "--detach is unavailable — supervised receiver persistence is not implemented; run receive in the foreground, in its own long-lived pane, per the foreground-supervision recipe in skills/peardrop/SKILL.md.",
        flags.json
      );
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
          // The drop page lives on the Worker in remote mode, so the spec has to
          // travel with the tunnel registration for the page to render it.
          spec,
        }),
      });
      if (!res.ok) {
        throw new Error(`Worker registration failed with HTTP ${res.status}`);
      }
      tunnelRes = await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.fail(`Worker tunnel registration failed: ${message}. No public PearDrop URL was created.`, flags.json);
    }

    const tunnelState: TunnelSession = {
      tunnelId: tunnelRes.slug,
      url: tunnelRes.url,
      fingerprint,
      pin: pinCode,
      target: flags.target,
      expiresAt: Date.now() + ttlSec * 1000,
      relayAllowed: tunnelRes.relayAllowed ?? allowRelay,
      ownerToken: tunnelRes.ownerToken,
      workerUrl,
      mode: "remote",
      status: "waiting",
    };

    await runEffect(saveSession(tunnelState));

    // The safe cancellation reference for every event below: cancel.ts already
    // loads the owner token back out of the 0600 session file on disk, so no
    // authority has to travel through stdout for cancellation to work.
    const cancelWith = `peardrop cancel ${tunnelState.tunnelId}`;
    const fieldCount = spec ? spec.fields.length : 1;

    if (flags.json) {
      // Single-line, compact and flushed so a piped consumer can read one line
      // and parse the Drop URL immediately, the same way `local --json` does.
      // Built explicitly rather than spread from tunnelState — tunnelState
      // carries ownerToken, the receiver's management credential, and a
      // spread would put it in an agent transcript that outlives the process
      // (peardrop#86).
      await writeStdout(JSON.stringify({
        tunnelId: tunnelState.tunnelId,
        url: tunnelState.url,
        fingerprint: tunnelState.fingerprint,
        target: tunnelState.target,
        expiresAt: tunnelState.expiresAt,
        relayAllowed: tunnelState.relayAllowed,
        workerUrl: tunnelState.workerUrl,
        mode: tunnelState.mode,
        status: tunnelState.status,
        pin: tunnelState.pin,
        event: "session",
        relayFallbackAllowed: tunnelState.relayAllowed,
        selectedTransport: null,
        cancelWith,
        elapsedMs: elapsedMs(),
        pid: process.pid,
      }));
      writeVerbose("session", { status: "waiting", relayFallbackAllowed: tunnelState.relayAllowed });
    } else if (flags.verbose) {
      writeVerbose("session", { status: "waiting", relayFallbackAllowed: tunnelState.relayAllowed, target: flags.target });
    }

    const abort = new AbortController();
    // `cancel.ts` already makes the Worker DELETE that tears a tunnel down
    // properly — it just was never called from here. Without it, killing this
    // process (Ctrl-C, `kill <pid>`, anything short of `peardrop cancel`) left
    // the Worker's KV record alive until its TTL, so the drop page kept
    // answering 200 with nothing behind it: a sender could paste a live
    // credential into a page nothing would ever collect (peardrop#35). Only
    // a genuine SIGINT/SIGTERM should trigger this — a natural completion
    // (delivered, or an internal abort like a declined relay-overage payment)
    // already updates the Worker's own state correctly on its own.
    let signalReceived = false;
    const onSignal = () => {
      signalReceived = true;
      abort.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    let relayAuthorizationFailure: string | undefined;
    let deliveryConfirmed = false;
    let receiverCompleted = false;
    let expired = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const checkExpiry = () => {
      if (abort.signal.aborted || deliveryConfirmed) return;
      const remaining = tunnelState.expiresAt - Date.now();
      if (remaining <= 0) {
        expired = true;
        abort.abort();
      } else {
        // Node clamps overflowing timer delays to 1ms; long TTLs need re-arming.
        expiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      }
    };
    checkExpiry();

    try {
      // The Worker needs a propagation moment before GET /api/tunnels/{slug}
      // answers 200 — sharing the URL the instant registration returns can hand
      // an agent a link that still 404s. Poll here, bounded, instead of leaving
      // every operator to hand-write the same curl loop.
      const readiness = await pollShareReadiness({
        // An unread body would hold its connection open in undici's pool until
        // GC, up to ~10 times over a full budget — only `.ok` is needed here,
        // so the body is cancelled immediately after every poll.
        fetchTunnel: async (signal) => {
          const res = await fetch(`${workerUrl}/api/tunnels/${tunnelState.tunnelId}`, { signal });
          const ok = res.ok;
          await res.body?.cancel().catch(() => undefined);
          return { ok };
        },
        signal: abort.signal,
        sleep,
      });

      const printBanner = (pending: boolean) => {
        const freeTierMB = RELAY_FREE_TIER_BYTES / (1024 * 1024);
        this.log("\n=========================================");
        this.log(` PearDrop Receiver Active`);
        this.log(` URL: ${tunnelState.url}`);
        this.log(` Fingerprint: ${fingerprint}`);
        if (pinCode) this.log(` PIN required: ${pinCode}`);
        this.log(` Target path: ${flags.target}`);
        this.log(
          ` Relay fallback: ${tunnelState.relayAllowed ? `Allowed (free up to ${freeTierMB}MB, then metered — max $0.06)` : "Disallowed (Direct-only)"}`
        );
        this.log("=========================================\n");
        if (pending) {
          this.log(`Not yet resolvable — re-check GET /api/tunnels/${tunnelState.tunnelId} before sharing this URL.`);
        }
        this.log("Waiting for sender connection...");
      };

      if (readiness !== "aborted") {
        const shareFields = {
          mode: "remote" as const,
          url: tunnelState.url,
          fingerprint,
          expiresAt: tunnelState.expiresAt,
          target: flags.target,
          tunnelId: tunnelState.tunnelId,
          fieldCount,
          ...(pinCode !== undefined ? { pin: pinCode } : {}),
          cancelWith,
        };
        if (readiness === "ready") {
          // The only event an agent may share a URL from.
          if (flags.json) {
            await writeStdout(JSON.stringify({ ...shareFields, event: "share_ready", elapsedMs: elapsedMs(), pid: process.pid }));
          } else if (!flags.verbose) {
            printBanner(false);
          }
          writeVerbose("share_ready", { url: tunnelState.url, fieldCount });
        } else {
          const reason = `Worker did not confirm tunnel readiness (GET /api/tunnels/${tunnelState.tunnelId}) within ${READINESS_BUDGET_MS}ms`;
          if (flags.json) {
            await writeStdout(JSON.stringify({ ...shareFields, event: "share_pending", reason, elapsedMs: elapsedMs(), pid: process.pid }));
          } else if (!flags.verbose) {
            printBanner(true);
          }
          writeVerbose("share_pending", { reason });
        }
      }

      // Lazy relay authorization. The Worker's own relay accounting is the only
      // honest signal that direct P2P did not carry the transfer, so poll it and
      // reach for the wallet exactly once relayed bytes trend over the free tier.
      // Below that threshold no wallet is loaded and the Worker is never asked
      // for payment requirements.
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
            Effect.exit(authorizeRelayOverage({ workerUrl, relayCapGb: flags["relay-cap"], relayBytes })),
            { signal: abort.signal }
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
            signal: abort.signal,
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

      await runEffect(
        Effect.scoped(runDhtReceiver({
          keyPair,
          sink,
          signal: abort.signal,
          pin: pinCode,
          maxFiles: flags.files,
          maxBytes: flags["max-size"] ? flags["max-size"] * 1024 * 1024 : undefined,
          onConnected: async (details) => {
            abort.signal.throwIfAborted();
            if (flags.json) {
              await writeStdout(JSON.stringify({ mode: "remote", event: "connected", ...details, elapsedMs: elapsedMs(), pid: process.pid }));
            }
            const endpoint = details.remoteHost && details.remotePort ? ` endpoint=${details.remoteHost}:${details.remotePort}` : "";
            const peer = details.remotePublicKey ? ` peer=${details.remotePublicKey}` : "";
            if (flags.verbose) writeVerbose("connected", { transport: details.transport, endpoint: details.remoteHost && details.remotePort ? `${details.remoteHost}:${details.remotePort}` : undefined, peer: details.remotePublicKey, files: details.fileCount, bytes: details.totalBytes });
            else if (!flags.json) this.log(`Sender connected — transport=${details.transport}${endpoint}${peer} files=${details.fileCount} bytes=${details.totalBytes}; receiving payload...`);
          },
          onDelivered: async (files) => {
            abort.signal.throwIfAborted();
            await runEffect(updateSessionStatus(tunnelState.tunnelId, "waiting", {
              files: files as TunnelSession["files"],
            }));
            const consumption = await fetch(`${workerUrl}/api/tunnels/${tunnelState.tunnelId}/consumed`, {
              method: "POST",
              headers: { Authorization: `Bearer ${tunnelState.ownerToken}` },
              signal: abort.signal,
            });
            if (!consumption.ok) {
              throw new Error(`Worker delivery confirmation failed with HTTP ${consumption.status}`);
            }
            abort.signal.throwIfAborted();
            deliveryConfirmed = true;
            clearTimeout(expiryTimer);
            await runEffect(updateSessionStatus(tunnelState.tunnelId, "delivered"));
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
            if (flags.json) {
              await writeStdout(JSON.stringify({ mode: "remote", event: "delivered", transport: "hyperdht", files, elapsedMs: elapsedMs(), pid: process.pid }));
            }
            if (flags.verbose) writeVerbose("delivered", { transport: "hyperdht", files: files.length, status: "complete" });
            else if (!flags.json) {
              this.log("Payload delivered successfully; receiver exiting.");
            }
          },
        })),
        { signal: abort.signal }
      );
      receiverCompleted = true;
    } catch (error) {
      // Internal aborts are reported below as expiry or an actionable relay
      // failure, without leaking an Effect interrupt into the event stream.
      if (!relayAuthorizationFailure && !expired) throw error;
    } finally {
      clearTimeout(expiryTimer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      abort.abort();

      if (expired) {
        await runEffect(updateSessionStatus(tunnelState.tunnelId, "expired"))
          .catch(() => this.warn("Could not persist expired session status; the receiver is still exiting."));
      }

      if (signalReceived) {
        // Best-effort means shutdown can't hang on it either — a stalled
        // connection with no timeout would block the process from exiting
        // just as badly as an unhandled failure would.
        const cancelTimeout = new AbortController();
        const cancelTimer = setTimeout(() => cancelTimeout.abort(), 5_000);
        try {
          const cancelled = await fetch(`${workerUrl}/api/tunnels/${tunnelState.tunnelId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${tunnelState.ownerToken}` },
            signal: cancelTimeout.signal,
          });
          if (!cancelled.ok) {
            this.warn(`Tunnel cancellation on exit failed with HTTP ${cancelled.status} — the drop page may stay live until it expires.`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.warn(`Tunnel cancellation on exit failed (${message}) — the drop page may stay live until it expires.`);
        } finally {
          clearTimeout(cancelTimer);
        }
      }
      const status = deliveryConfirmed && receiverCompleted ? "complete" : expired ? "expired" : signalReceived ? "cancelled" : "failed";
      if (flags.json) {
        await writeStdout(JSON.stringify({ mode: "remote", event: "teardown", status, ...(expired ? { reason: "ttl-expired", expiresAt: tunnelState.expiresAt } : {}), elapsedMs: elapsedMs(), pid: process.pid }));
      } else if (expired) {
        this.log("Tunnel TTL expired; receiver exiting.");
      }
      writeVerbose("teardown", { status });
    }

    // The only point at which a missing wallet is an error: relay was actually
    // used, past the free tier, and nothing can pay for it.
    if (relayAuthorizationFailure) {
      return this.fail(relayAuthorizationFailure, flags.json);
    }
  }
}
