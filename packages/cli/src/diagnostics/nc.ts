import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import {
  RelaySenderError,
  sendRelay,
  type RelayDescriptor,
  type RelayFallback,
  type RelayFile,
  type RelayLifecycleEvent,
  type RelayMode,
  type RelaySendResult,
  type RelayWebSocket,
} from "@peardrop/core/relay";
import { runEffect } from "@peardrop/core/node";
import * as Effect from "effect/Effect";
import WebSocket from "ws";

const SENSITIVE_KEY = /(?:owner.?token|ticket|public.?key|private.?key|relay.?url|worker.?url|secret|^url$)/i;

export const redactDiagnosticValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactDiagnosticValue(child),
    ]));
  }
  if (typeof value === "string") {
    return value
      .replace(/(ownerToken|ticket|publicKey|privateKey|relayUrl|workerUrl|url)=\S+/gi, "$1=[REDACTED]")
      .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]");
  }
  return value;
};

export const parseBoundedTimeout = (value: string): number => {
  const match = /^(\d+)(ms|s|m)$/.exec(value.trim());
  if (!match) throw new Error("--timeout must be a duration such as 30s or 1m");
  const amount = Number(match[1]);
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000;
  const timeoutMs = amount * multiplier;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) {
    throw new Error("--timeout must be between 5s and 2m");
  }
  return timeoutMs;
};

type DiagnosticSource = "receiver" | "web-sender" | "relay" | "harness";
type JsonObject = Record<string, unknown>;

/**
 * Bound for the late-delivery watch. After `sendRelay` returns failure, the
 * diagnostic watches the receiver for this long: the sender's teardown does
 * not recall bytes already on the wire, so a `delivered` event arriving in
 * this window is the terminal-inconsistency condition (UI reported failure
 * while the underlying attempt delivered). Documented here so the bound is
 * visible to consumers; the diagnostic's red condition explicitly names it.
 */
const LATE_DELIVERY_WINDOW_MS = 2_000;
const LATE_DELIVERY_POLL_MS = 50;
/** Grace given to the receiver subprocess to land its own teardown line. */
const RECEIVER_TEARDOWN_GRACE_MS = 6_000;

export interface WebSenderInvocation {
  readonly descriptor: RelayDescriptor;
  readonly files: ReadonlyArray<RelayFile>;
  readonly workerUrl: string;
  readonly fallback: RelayFallback;
  readonly acceptTimeoutMs: number;
  readonly acceptPollMs: number;
  readonly onEvent: (event: RelayLifecycleEvent) => void;
  readonly signal: AbortSignal;
}

/**
 * The production web-sender boundary the hosted browser drop page, the forced
 * CLI `send --relay`, and the e2e relay harness all share. The diagnostic
 * invokes this directly — never a CLI subprocess approximation of it — so a
 * `test nc` result reflects the exact state machine a browser sender runs.
 */
export type WebSender = (invocation: WebSenderInvocation) => Promise<RelaySendResult>;

const defaultWebSender: WebSender = (invocation) =>
  runEffect(
    Effect.scoped(sendRelay({
      descriptor: invocation.descriptor,
      files: invocation.files,
      workerUrl: invocation.workerUrl,
      fallback: invocation.fallback,
      acceptTimeoutMs: invocation.acceptTimeoutMs,
      acceptPollMs: invocation.acceptPollMs,
      onEvent: invocation.onEvent,
    }, {
      fetch,
      createWebSocket: (url) => new WebSocket(url) as unknown as RelayWebSocket,
    })),
    { signal: invocation.signal },
  );

export interface NcDiagnosticOptions {
  readonly binPath: string;
  readonly timeoutMs: number;
  readonly workerUrl: string;
  readonly json: boolean;
  /** Override the production web sender. Defaults to the shared `sendRelay` boundary. Test-only. */
  readonly runWebSender?: WebSender;
}

export interface NcDiagnosticSummary {
  readonly event: "summary";
  readonly status: "passed" | "failed";
  readonly transport: "relay";
  readonly mode: "non-custodial";
  readonly elapsedMs: number;
  readonly phase: string;
  readonly senderOutcome?: "complete" | "failed" | "interrupted";
  readonly senderExitCode?: number;
  readonly receiverExitCode?: number;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly tunnelConsumed?: boolean;
  readonly artifactPath?: string;
  readonly error?: string;
}

export class NcDiagnosticError extends Error {
  constructor(readonly summary: NcDiagnosticSummary) {
    super(summary.error ?? `Non-custodial Relay diagnostic failed at ${summary.phase}`);
    this.name = "NcDiagnosticError";
  }
}

class DiagnosticFailure extends Error {
  constructor(readonly phase: string, message: string) {
    super(message);
    this.name = "DiagnosticFailure";
  }
}

const childExit = (child: ChildProcess): Promise<number> => {
  if (child.exitCode !== null && child.stdout?.readableEnded && child.stderr?.readableEnded) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
  });
};

const terminateChild = async (child: ChildProcess | undefined, graceMs = 1_000): Promise<void> => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    childExit(child).then(() => undefined),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, graceMs)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      childExit(child).then(() => undefined),
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000)),
    ]);
  }
};

const parseJsonLine = (line: string): JsonObject | undefined => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
};

const parseVerboseLine = (line: string): { source: DiagnosticSource; event: JsonObject } | undefined => {
  const sourceMatch = /^\[(receiver|web-sender|relay)\]\s/.exec(line);
  if (!sourceMatch) return undefined;
  const field = (name: string) => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line)?.[1];
  const attempt = field("attempt");
  return {
    source: sourceMatch[1] as DiagnosticSource,
    event: {
      event: "log",
      phase: field("phase") ?? "stderr",
      ...(attempt === undefined ? {} : { attempt: Number(attempt) }),
      ...(field("transport") === undefined ? {} : { transport: field("transport") }),
      ...(field("mode") === undefined ? {} : { mode: field("mode") }),
      message: line,
    },
  };
};

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

export async function runNcDiagnostic(options: NcDiagnosticOptions): Promise<NcDiagnosticSummary> {
  const startedAt = performance.now();
  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  const diagnosticRoot = join(homedir(), ".cache", "peardrop", "diagnostics");
  await mkdir(diagnosticRoot, { recursive: true, mode: 0o700 });
  const artifactPath = join(diagnosticRoot, `nc-${Date.now()}-${process.pid}.jsonl`);
  await writeFile(artifactPath, "", { mode: 0o600 });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "peardrop-nc-"));
  const inbox = join(temporaryRoot, "inbox");
  await mkdir(inbox, { mode: 0o700 });
  const payload = `peardrop-nc-diagnostic-${randomUUID()}`;
  const expectedBytes = Buffer.byteLength(payload, "utf8");
  const expectedHash = createHash("sha256").update(payload).digest("hex");
  const runWebSender = options.runWebSender ?? defaultWebSender;
  let receiver: ChildProcess | undefined;
  let sessionSlug: string | undefined;
  let sessionOwnerToken: string | undefined;
  let receiverDelivered: JsonObject | undefined;
  let receiverDeliveredAt: number | undefined;
  let lastPhase: string | undefined;
  let failedPhase: string | undefined;
  let sequence = 0;
  let artifactWrites = Promise.resolve();
  let succeeded = false;
  let senderOutcome: "complete" | "failed" | "interrupted" | undefined;
  let senderExitCode: number | undefined;
  let receiverExitCode: number | undefined;
  let abortFailure: DiagnosticFailure | undefined;
  let failureSummary: NcDiagnosticSummary | undefined;

  const record = (source: DiagnosticSource, channel: "stdout" | "stderr" | "internal", pid: number, value: unknown) => {
    const sanitized = redactDiagnosticValue(value);
    const object = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized as JsonObject : undefined;
    const routedSource: DiagnosticSource = object?.event === "relay" ? "relay" : source;
    const phase = typeof object?.phase === "string"
      ? object.phase
      : typeof object?.event === "string"
        ? object.event
        : channel;
    if (object) lastPhase = phase;
    if (object?.status === "failed" || object?.event === "error") failedPhase = phase;
    const entry = {
      event: "diagnostic",
      sequence: ++sequence,
      source: routedSource,
      channel,
      elapsedMs: elapsedMs(),
      pid,
      phase,
      attempt: object?.attempt,
      transport: object?.transport,
      mode: object?.mode,
      data: sanitized,
    };
    artifactWrites = artifactWrites.then(() => appendFile(artifactPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
      return;
    }
    const detail = object
      ? Object.entries(object)
          .filter(([key]) => !["event", "phase", "elapsedMs", "pid", "attempt", "transport", "mode"].includes(key))
          .map(([key, child]) => `${key}=${typeof child === "object" ? JSON.stringify(child) : String(child)}`)
          .join(" ")
      : String(sanitized);
    process.stderr.write(`[${routedSource}] elapsedMs=${entry.elapsedMs} pid=${pid} phase=${phase}${entry.attempt === undefined ? "" : ` attempt=${String(entry.attempt)}`}${entry.transport === undefined ? "" : ` transport=${String(entry.transport)}`}${detail ? ` ${detail}` : ""}\n`);
  };

  let resolveSession: ((slug: string) => void) | undefined;
  let rejectSession: ((error: Error) => void) | undefined;
  const sessionReady = new Promise<string>((resolveReady, rejectReady) => {
    resolveSession = resolveReady;
    rejectSession = rejectReady;
  });
  const senderAbort = new AbortController();
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (phase: string, message: string) => {
    if (abortFailure) return;
    abortFailure = new DiagnosticFailure(phase, message);
    senderAbort.abort();
    rejectAbort?.(abortFailure);
  };
  const timeout = setTimeout(() => abort(failedPhase ?? lastPhase ?? "timeout", `Diagnostic exceeded ${options.timeoutMs}ms`), options.timeoutMs);
  const onSignal = (signal: NodeJS.Signals) => abort("signal", `Diagnostic interrupted by ${signal}`);
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const attachLines = (child: ChildProcess, source: "receiver") => {
    if (!child.stdout || !child.stderr) throw new DiagnosticFailure("spawn", `${source} stdio was unavailable`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const parsed = parseJsonLine(line);
      if (parsed?.event === "session" && typeof parsed.tunnelId === "string") {
        sessionSlug = parsed.tunnelId;
        if (typeof parsed.ownerToken === "string") sessionOwnerToken = parsed.ownerToken;
        resolveSession?.(parsed.tunnelId);
      }
      if (parsed?.event === "delivered") {
        receiverDelivered = parsed;
        receiverDeliveredAt = elapsedMs();
      }
      record(source, "stdout", child.pid ?? -1, parsed ?? line);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      const parsed = parseJsonLine(line);
      const verbose = parsed ? undefined : parseVerboseLine(line);
      record(verbose?.source ?? source, "stderr", child.pid ?? -1, parsed ?? verbose?.event ?? line);
    });
  };

  try {
    receiver = spawn(process.execPath, [
      options.binPath,
      "receive",
      "--json",
      "--verbose",
      "--ttl",
      "2m",
      "--target",
      `${inbox}/`,
      "--worker-url",
      options.workerUrl,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    attachLines(receiver, "receiver");
    void childExit(receiver).then((code) => {
      if (!sessionSlug) rejectSession?.(new DiagnosticFailure("receiver-session", `Receiver exited ${code} before creating a session`));
    });
    const slug = await Promise.race([sessionReady, aborted]);

    // The hosted web sender resolves the tunnel descriptor (publicKey) from the
    // Worker before invoking `sendRelay`; the diagnostic drives the same route.
    const descriptorStartedAt = elapsedMs();
    record("web-sender", "internal", process.pid, { event: "web-sender", phase: "descriptor-fetch", status: "start", transport: "relay" });
    let descriptor: RelayDescriptor;
    try {
      const response = await Promise.race([fetch(`${options.workerUrl.replace(/\/$/, "")}/api/tunnels/${slug}`), aborted]);
      if (!response.ok) throw new Error(`Tunnel descriptor request failed with HTTP ${response.status}`);
      const body = await response.json() as { publicKey?: string };
      if (!body.publicKey) throw new Error("Tunnel descriptor missing publicKey");
      descriptor = { slug, publicKey: body.publicKey };
    } catch (cause) {
      throw new DiagnosticFailure("descriptor-fetch", cause instanceof Error ? cause.message : String(cause));
    }
    record("web-sender", "internal", process.pid, {
      event: "web-sender",
      phase: "descriptor-fetch",
      status: "complete",
      durationMs: elapsedMs() - descriptorStartedAt,
      transport: "relay",
    });

    const senderStartedAt = performance.now();
    const relayFile: RelayFile = {
      name: "pasted-secret.txt",
      size: expectedBytes,
      stream: () => {
        const encoded = new TextEncoder().encode(payload);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        });
      },
    };
    const webSenderDescriptorMs = elapsedMs();
    record("web-sender", "internal", process.pid, {
      event: "web-sender",
      phase: "invoke",
      status: "start",
      transport: "relay",
      mode: "non-custodial",
    });

    let senderResult: RelaySendResult | undefined;
    let senderFailure: DiagnosticFailure | undefined;
    try {
      senderResult = await Promise.race([
        runWebSender({
          descriptor,
          files: [relayFile],
          workerUrl: options.workerUrl.replace(/\/$/, ""),
          fallback: "none",
          acceptTimeoutMs: options.timeoutMs,
          acceptPollMs: 1_000,
          onEvent: (event) => {
            const adjusted: RelayLifecycleEvent = {
              ...event,
              elapsedMs: webSenderDescriptorMs + event.elapsedMs,
            };
            record("web-sender", "internal", process.pid, { ...adjusted, pid: process.pid });
          },
          signal: senderAbort.signal,
        }),
        aborted,
      ]);
      senderOutcome = "complete";
      senderExitCode = 0;
      record("web-sender", "internal", process.pid, {
        event: "web-sender",
        phase: "complete",
        status: "complete",
        mode: senderResult.mode,
        transport: "relay",
        elapsedMs: elapsedMs(),
        durationMs: Math.round(performance.now() - senderStartedAt),
      });
    } catch (cause) {
      if (cause instanceof DiagnosticFailure) {
        senderFailure = cause;
      } else if (cause instanceof RelaySenderError) {
        senderFailure = new DiagnosticFailure(cause.phase, cause.message);
      } else if (abortFailure) {
        senderFailure = abortFailure;
      } else {
        senderFailure = new DiagnosticFailure(failedPhase ?? lastPhase ?? "web-sender", cause instanceof Error ? cause.message : String(cause));
      }
      senderOutcome = abortFailure ? "interrupted" : "failed";
      senderExitCode = 1;
      record("web-sender", "internal", process.pid, {
        event: "web-sender",
        phase: senderFailure.phase,
        status: "failed",
        mode: "non-custodial",
        transport: "relay",
        elapsedMs: elapsedMs(),
        durationMs: Math.round(performance.now() - senderStartedAt),
        error: senderFailure.message,
      });
    }

    // Terminal consistency: after the web sender returns failure or is
    // interrupted, await the sender's bounded teardown before reporting
    // terminal failure. The sender's Effect scope closes its WebSocket, DHT,
    // and peer (`Effect.scoped` guarantees finalizers complete before the
    // Effect returns — `runEffect` resolves only once teardown is finished).
    // Then watch the receiver for the documented late-delivery window: bytes
    // already on the wire are not recalled by the sender's teardown, so a
    // `delivered` event arriving here is the terminal-inconsistency condition
    // the diagnostic must turn red on.
    if (senderFailure && !receiverDelivered) {
      const watchStartedAt = elapsedMs();
      const watchDeadline = Date.now() + LATE_DELIVERY_WINDOW_MS;
      while (Date.now() < watchDeadline && !receiverDelivered) {
        await Promise.race([sleep(LATE_DELIVERY_POLL_MS, senderAbort.signal), aborted]).catch(() => undefined);
      }
      if (receiverDelivered) {
        const lateMs = elapsedMs() - watchStartedAt;
        record("harness", "internal", process.pid, {
          event: "terminal-consistency",
          phase: "late-delivery",
          status: "failed",
          windowMs: LATE_DELIVERY_WINDOW_MS,
          arrivedAfterMs: lateMs,
          senderFailurePhase: senderFailure.phase,
        });
        throw new DiagnosticFailure(
          "late-delivery",
          `Web sender reported failure at ${senderFailure.phase} but receiver delivered ${lateMs}ms later within the ${LATE_DELIVERY_WINDOW_MS}ms window — terminal inconsistency: underlying attempt continued invisibly after terminal failure`,
        );
      }
      record("harness", "internal", process.pid, {
        event: "terminal-consistency",
        phase: "late-delivery-watch",
        status: "complete",
        windowMs: LATE_DELIVERY_WINDOW_MS,
        delivered: false,
      });
    }

    if (senderFailure) throw senderFailure;

    // The receiver should have reported delivery by now (sender succeeded and
    // the bytes flowed through the production shared boundary).
    receiverExitCode = await Promise.race([childExit(receiver), aborted]);
    if (receiverExitCode !== 0) throw new DiagnosticFailure(failedPhase ?? lastPhase ?? "receiver-exit", `Receiver exited ${receiverExitCode}`);
    if (!receiverDelivered) throw new DiagnosticFailure("receiver-delivered", "Receiver exited without a delivered event");

    const deliveredFiles = Array.isArray(receiverDelivered.files) ? receiverDelivered.files : [];
    const delivered = deliveredFiles[0] && typeof deliveredFiles[0] === "object" ? deliveredFiles[0] as JsonObject : undefined;
    const deliveredPath = typeof delivered?.path === "string" ? resolve(delivered.path) : join(inbox, "pasted-secret.txt");
    if (dirname(deliveredPath) !== resolve(inbox)) throw new DiagnosticFailure("verify-path", "Receiver reported a path outside the isolated inbox");
    const received = await readFile(deliveredPath);
    const receivedHash = createHash("sha256").update(received).digest("hex");
    if (received.length !== expectedBytes) throw new DiagnosticFailure("verify-bytes", `Expected ${expectedBytes} bytes, received ${received.length}`);
    if (receivedHash !== expectedHash) throw new DiagnosticFailure("verify-hash", `Expected ${expectedHash}, received ${receivedHash}`);
    if (received.toString("utf8") !== payload) throw new DiagnosticFailure("verify-content", "Received content did not match the generated payload");

    const consumedResponse = await Promise.race([
      fetch(`${options.workerUrl.replace(/\/$/, "")}/api/tunnels/${slug}`),
      aborted,
    ]);
    if (consumedResponse.status !== 404) throw new DiagnosticFailure("tunnel-consumed", `Consumed tunnel returned HTTP ${consumedResponse.status}`);
    const summary: NcDiagnosticSummary = {
      event: "summary",
      status: "passed",
      transport: "relay",
      mode: "non-custodial",
      elapsedMs: elapsedMs(),
      phase: "complete",
      senderOutcome,
      senderExitCode,
      receiverExitCode,
      bytes: received.length,
      sha256: receivedHash,
      tunnelConsumed: true,
    };
    record("harness", "internal", process.pid, summary);
    succeeded = true;
    return summary;
  } catch (cause) {
    const failure = cause instanceof DiagnosticFailure
      ? cause
      : abortFailure ?? new DiagnosticFailure(failedPhase ?? lastPhase ?? "unknown", cause instanceof Error ? cause.message : String(cause));
    const summary: NcDiagnosticSummary = {
      event: "summary",
      status: "failed",
      transport: "relay",
      mode: "non-custodial",
      elapsedMs: elapsedMs(),
      phase: failure.phase,
      senderOutcome,
      senderExitCode,
      receiverExitCode,
      tunnelConsumed: false,
      artifactPath,
      error: failure.message,
    };
    failureSummary = summary;
    throw new NcDiagnosticError(summary);
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    senderAbort.abort();
    if (!succeeded && sessionSlug && sessionOwnerToken) {
      const cancellation = new AbortController();
      const cancellationTimeout = setTimeout(() => cancellation.abort(), 5_000);
      try {
        const response = await fetch(`${options.workerUrl.replace(/\/$/, "")}/api/tunnels/${sessionSlug}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${sessionOwnerToken}` },
          signal: cancellation.signal,
        });
        record("harness", "internal", process.pid, {
          event: "cleanup",
          phase: "tunnel-cancel",
          status: response.ok || response.status === 404 ? "complete" : "failed",
          httpStatus: response.status,
        });
      } catch (cause) {
        record("harness", "internal", process.pid, {
          event: "cleanup",
          phase: "tunnel-cancel",
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        clearTimeout(cancellationTimeout);
      }
    }
    await terminateChild(receiver, RECEIVER_TEARDOWN_GRACE_MS);
    await rm(temporaryRoot, { recursive: true, force: true });
    if (receiverDeliveredAt !== undefined) {
      record("harness", "internal", process.pid, {
        event: "cleanup",
        phase: "receiver-delivery-evidence",
        deliveredAtMs: receiverDeliveredAt,
        status: "complete",
      });
    }
    if (failureSummary) record("harness", "internal", process.pid, failureSummary);
    await artifactWrites;
    if (succeeded) await rm(artifactPath, { force: true });
  }
}

export type { RelayMode };
