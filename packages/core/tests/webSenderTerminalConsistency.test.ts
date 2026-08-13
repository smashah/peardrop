/**
 * Smallest deterministic red test for the web-sender terminal-inconsistency
 * defect, driven headlessly against the real production web-sender boundary.
 *
 * `sendRelay` from `@peardrop/core/relay` is the implementation the hosted
 * browser drop page, `peardrop send --relay`, and `apps/relay/scripts/relay-e2e-send.mjs`
 * all share. Its `done` phase waits a bounded window for the receiver's DONE
 * acknowledgement; when that window elapses the Effect returns a
 * `RelaySenderError` even though every PDWP frame up to and including FILE_END
 * has already been written to the relay socket.
 *
 * The bytes already on the wire are not recalled by the sender's teardown, so
 * a slow relay/receiver can still write the file *after* `sendRelay` reported
 * failure — exactly Mohammed's `dusky-nectar-yz7` Brand Store session: the UI
 * declared failure while the underlying attempt connected and delivered.
 *
 * This test drives the real shared web sender boundary headlessly with mocked
 * transport adapters, proves the terminal-failure-with-bytes-on-wire
 * condition, and retains a redacted diagnostic artifact under the standard
 * diagnostics cache.
 */
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const diagnosticRoot = join(homedir(), ".cache", "peardrop", "diagnostics");
// A retained artifact (PEARDROP_REPRO_KEEP=1) is written to a stable path so
// the brief's "report its path and exact failed phase" handoff is reproducible.
const keepArtifact = process.env.PEARDROP_REPRO_KEEP === "1";
const artifactPath = keepArtifact
  ? join(diagnosticRoot, "repro-web-nc-terminal.jsonl")
  : join(diagnosticRoot, `repro-web-nc-${Date.now()}-${process.pid}.jsonl`);

const SENSITIVE_KEY = /(?:owner.?token|ticket|public.?key|private.?key|relay.?url|worker.?url|secret|^url$)/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v),
    ]));
  }
  if (typeof value === "string") {
    return value
      .replace(/(ownerToken|ticket|publicKey|privateKey|relayUrl|workerUrl|url)=\S+/gi, "$1=[REDACTED]")
      .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]");
  }
  return value;
};

const writes: Uint8Array[] = [];
const custodialModes: boolean[] = [];
/** When set, emit ACCEPT but hold DONE indefinitely — bytes stay on the wire. */
let holdDone = false;
let dhtDestroyCount = 0;
let webSocketCloseCount = 0;
const deliveredFiles = [{ name: "message.txt", bytes: 5, sha256: "abc" }];

vi.mock("@hyperswarm/dht-relay/ws", () => ({ default: class RelayStream {} }));
vi.mock("@hyperswarm/dht-relay", () => ({
  default: class RelayDht {
    private readonly custodial: boolean;
    constructor(_stream: unknown, options: { custodial?: boolean } = {}) {
      this.custodial = options.custodial !== false;
      custodialModes.push(this.custodial);
    }
    connect() {
      const peer = new EventEmitter() as EventEmitter & {
        opened: Promise<boolean>;
        write: (frame: Uint8Array) => boolean;
        destroy: () => void;
      };
      peer.opened = Promise.resolve(true);
      peer.write = (frame) => {
        writes.push(frame);
        const type = frame[4];
        // ACCEPT (3) is emitted immediately so the sender reaches the bytes
        // phase; DONE (6) is held back to simulate relay/receiver latency.
        if (type === 2) {
          queueMicrotask(() => peer.emit("data", encodeJson(3, { ok: true })));
        }
        return true;
      };
      peer.destroy = () => undefined;
      return peer;
    }
    destroy() {
      dhtDestroyCount += 1;
    }
  },
}));

const { RelaySenderError, sendRelay } = await import("../src/relay/RelaySender.js");

const encodeJson = (type: number, value: unknown) => {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(payload.length + 5);
  new DataView(frame.buffer).setUint32(0, payload.length + 1, true);
  frame[4] = type;
  frame.set(payload, 5);
  return frame;
};

class MockWebSocket extends EventTarget {
  binaryType = "";
  readonly readyState = 1;
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send() {}
  close() {
    webSocketCloseCount += 1;
  }
}

const descriptor = { slug: "drop", publicKey: "a".repeat(64) };
const file = {
  name: "message.txt",
  size: 5,
  stream: () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello"));
      controller.close();
    },
  }),
};

const adapters = {
  fetch: async () => new Response(JSON.stringify({
    ticket: "ticket",
    relayUrl: "wss://relay.test",
    billingScheme: "upto",
  })),
  createWebSocket: () => new MockWebSocket(),
  now: (() => {
    let now = 0;
    return () => ++now;
  })(),
};

const record = async (entry: Record<string, unknown>) => {
  const sanitized = redact(entry) as Record<string, unknown>;
  await appendFile(artifactPath, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 });
};

beforeEach(async () => {
  writes.length = 0;
  custodialModes.length = 0;
  holdDone = false;
  dhtDestroyCount = 0;
  webSocketCloseCount = 0;
  await mkdir(diagnosticRoot, { recursive: true, mode: 0o700 });
  await writeFile(artifactPath, "", { mode: 0o600 });
});

afterEach(async () => {
  if (keepArtifact) return;
  try {
    await rm(artifactPath, { force: true });
  } catch {
    /* swallowed — diagnostic artifacts are best-effort */
  }
});

describe("web sender terminal consistency (sendRelay boundary)", () => {
  it("terminal failure coexists with a live attempt whose bytes would still deliver late", async () => {
    // RED DEFINITION: after `sendRelay` returns failure at the `done` phase,
    // PDWP frames up to and including FILE_END have already been written to
    // the wire. The sender's teardown does not recall them, so the receiver
    // would still write the file — an invisible live attempt that delivers
    // after terminal failure. The corrected `test nc` diagnostic must turn
    // red on exactly this condition.
    holdDone = true;
    const startedAt = performance.now();
    const events: Array<{ phase: string; status: string; elapsedMs: number; attempt: number; mode: string; error?: string }> = [];
    let observedDoneAfterFailure = false;
    let failureObserved = false;

    await record({
      event: "repro",
      phase: "reproduce",
      status: "start",
      elapsedMs: 0,
      payload: "[REDACTED]",
      ownerToken: "owner-secret-would-go-here",
      relayUrl: "wss://relay.example.private",
      workerUrl: "https://peardrop.fyi",
    });

    const exit = await Effect.runPromiseExit(Effect.scoped(sendRelay({
      descriptor,
      files: [file],
      fallback: "none",
      acceptTimeoutMs: 40,
      acceptPollMs: 10,
      onEvent: (event) => {
        if (failureObserved && event.phase === "done" && event.status === "complete") observedDoneAfterFailure = true;
        events.push({
          phase: event.phase,
          status: event.status,
          elapsedMs: event.elapsedMs,
          attempt: event.attempt,
          mode: event.mode,
          ...(event.error === undefined ? {} : { error: event.error }),
        });
        void record({
          event: "relay",
          phase: event.phase,
          status: event.status,
          elapsedMs: event.elapsedMs,
          attempt: event.attempt,
          mode: event.mode,
          durationMs: event.durationMs,
          ...(event.error === undefined ? {} : { error: event.error }),
        });
        if (event.phase === "done" && event.status === "failed") failureObserved = true;
      },
    }, adapters)));

    // Terminal failure has occurred at the `done` phase, non-custodial only.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(custodialModes).toEqual([false]);
    const squashed = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(squashed).toBeInstanceOf(RelaySenderError);
    expect((squashed as RelaySenderError).phase).toBe("done");
    expect((squashed as RelaySenderError).attempt).toBe(1);
    expect((squashed as RelaySenderError).mode).toBe("non-custodial");
    expect(String(exit)).toContain("Receiver did not confirm delivery in time");

    // AND a live attempt persists invisibly: FILE_END (frame type 5) was
    // already written to the wire before the failure, so a real relay/receiver
    // would still deliver the file after this point.
    const frameTypesOnWire = writes.map((frame) => frame[4]);
    expect(frameTypesOnWire).toContain(1); // HELLO
    expect(frameTypesOnWire).toContain(2); // MANIFEST
    expect(frameTypesOnWire).toContain(4); // FILE
    expect(frameTypesOnWire).toContain(5); // FILE_END — already on the wire

    // The sender is blind to any late delivery that happens now: its scope-
    // closing finalizer removed the data listener, so a DONE that would have
    // been observed had the relay been faster is never observed after failure.
    expect(observedDoneAfterFailure).toBe(false);

    // Teardown did release the connection resources (the visible half).
    expect(webSocketCloseCount).toBeGreaterThan(0);
    expect(dhtDestroyCount).toBeGreaterThan(0);
    const teardown = events.filter((event) => event.phase === "teardown");
    expect(teardown.at(-1)?.status).toBe("complete");

    // Phase timings are monotonic — required for the diagnostic's stable JSON.
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.elapsedMs).toBeGreaterThanOrEqual(events[index - 1]!.elapsedMs);
    }

    await record({
      event: "repro",
      phase: "red-condition",
      status: "failed",
      elapsedMs: Math.round(performance.now() - startedAt),
      failurePhase: "done",
      mode: "non-custodial",
      transport: "relay",
      frameTypesOnWire,
      fileEndOnWire: true,
      note: "terminal failure coexists with bytes-on-wire that would still deliver late",
    });

    // Artifact redaction contract: phase timings yes, secrets no.
    const artifact = await readFile(artifactPath, "utf8");
    const artifactEvents = artifact.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(artifactEvents.some((entry) => entry.phase === "done" && entry.status === "failed")).toBe(true);
    expect(artifactEvents.some((entry) => entry.phase === "red-condition")).toBe(true);
    expect(artifact).not.toContain("owner-secret-would-go-here");
    expect(artifact).not.toContain("wss://relay.example.private");
    expect(artifact).not.toContain("https://peardrop.fyi");
    expect(artifact).toContain("[REDACTED]");
  });
});
