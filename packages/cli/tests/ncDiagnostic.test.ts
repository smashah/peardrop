import { createServer } from "node:http";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NcDiagnosticError,
  parseBoundedTimeout,
  redactDiagnosticValue,
  runNcDiagnostic,
  type WebSender,
  type WebSenderInvocation,
} from "../src/diagnostics/nc.js";
import { RelaySenderError, type RelayLifecycleEvent } from "@peardrop/core/relay";

const temporaryPaths: string[] = [];
const PAYLOAD_FILE = join(tmpdir(), "peardrop-nc-receiver-payload");
const PAYLOAD_PENDING_FILE = `${PAYLOAD_FILE}.pending`;
const CANCELLED_FILE = join(tmpdir(), "peardrop-nc-receiver-cancelled");

const exists = async (path: string) => stat(path).then(() => true, () => false);

const startWorkerDouble = async (descriptorPublicKey = "a".repeat(64)) => {
  const requests: Array<{ method: string; url: string; authorization?: string }> = [];
  const descriptorFetchesPerSlug = new Map<string, number>();
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
    });
    const slugMatch = /^\/api\/tunnels\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "GET" && slugMatch) {
      const slug = slugMatch[1]!;
      const count = descriptorFetchesPerSlug.get(slug) ?? 0;
      // First GET returns the descriptor; subsequent GETs report the tunnel as
      // torn down (404), exactly like the real Worker after delivery.
      if (count === 0) {
        descriptorFetchesPerSlug.set(slug, count + 1);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ publicKey: descriptorPublicKey }));
        return;
      }
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test Worker did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
};

const emitRelay = (invocation: WebSenderInvocation, phase: string, status: "start" | "complete" | "failed", extra: Partial<RelayLifecycleEvent> = {}) => {
  invocation.onEvent({
    event: "relay",
    attempt: 1,
    mode: "non-custodial",
    phase: phase as RelayLifecycleEvent["phase"],
    status,
    elapsedMs: 1,
    ...extra,
  });
};

/** Reads the payload from the invocation's file stream and stages it where the receiver fixture waits. */
const stagePayload = async (invocation: WebSenderInvocation): Promise<string> => {
  const reader = invocation.files[0]?.stream().getReader();
  const chunks: Uint8Array[] = [];
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  }
  const payload = new TextDecoder().decode(Buffer.concat(chunks));
  // Publish only after the complete payload is flushed. Writing the watched
  // path directly exposes the truncate-before-write window, allowing the
  // receiver fixture to consume an empty file and exit successfully.
  await writeFile(PAYLOAD_PENDING_FILE, payload);
  await rename(PAYLOAD_PENDING_FILE, PAYLOAD_FILE);
  return payload;
};

const receiverFixture = String.raw`
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const target = args[args.indexOf("--target") + 1];
const payloadFile = ${JSON.stringify(PAYLOAD_FILE)};
const waitFor = async (p) => { for (;;) { try { return await readFile(p, "utf8"); } catch { await new Promise((r) => setTimeout(r, 5)); } } };
console.log(JSON.stringify({ event: "session", tunnelId: "test-drop", ownerToken: "owner-secret", phase: "session" }));
const payload = await waitFor(payloadFile);
await mkdir(target, { recursive: true });
const path = join(target, "pasted-secret.txt");
await writeFile(path, payload);
const sha256 = createHash("sha256").update(payload).digest("hex");
console.log(JSON.stringify({ event: "connected", phase: "connected", transport: "hyperdht" }));
console.log(JSON.stringify({ event: "delivered", phase: "delivered", files: [{ path, bytes: Buffer.byteLength(payload), sha256 }] }));
console.log(JSON.stringify({ event: "teardown", phase: "teardown", status: "complete" }));
`;

const idleReceiverFixture = String.raw`
import { writeFile } from "node:fs/promises";
process.once("SIGTERM", () => setTimeout(async () => {
  await writeFile(${JSON.stringify(CANCELLED_FILE)}, "yes");
  console.log(JSON.stringify({ event: "teardown", phase: "teardown", status: "cancelled" }));
  process.exit(0);
}, 200));
console.log(JSON.stringify({ event: "session", tunnelId: "test-drop", ownerToken: "owner-secret", phase: "session" }));
setInterval(() => undefined, 1000);
`;

const lateDeliveryReceiverFixture = (delayMs: number) => String.raw`
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const target = args[args.indexOf("--target") + 1];
const payloadFile = ${JSON.stringify(PAYLOAD_FILE)};
const waitFor = async (p) => { for (;;) { try { return await readFile(p, "utf8"); } catch { await new Promise((r) => setTimeout(r, 5)); } } };
console.log(JSON.stringify({ event: "session", tunnelId: "test-drop", ownerToken: "owner-secret", phase: "session" }));
const payload = await waitFor(payloadFile);
await new Promise((r) => setTimeout(r, ${delayMs}));
await mkdir(target, { recursive: true });
const path = join(target, "pasted-secret.txt");
await writeFile(path, payload);
const sha256 = createHash("sha256").update(payload).digest("hex");
console.log(JSON.stringify({ event: "delivered", phase: "delivered", files: [{ path, bytes: Buffer.byteLength(payload), sha256 }] }));
console.log(JSON.stringify({ event: "teardown", phase: "teardown", status: "complete" }));
`;

const stubCompletingWebSender: WebSender = async (invocation) => {
  for (const [phase, status] of [
    ["ticket-request", "start"], ["ticket-request", "complete"],
    ["socket-open", "start"], ["socket-open", "complete"],
    ["dht-connect", "start"], ["dht-connect", "complete"],
    ["hello", "start"], ["hello", "complete"],
    ["manifest", "start"], ["manifest", "complete"],
    ["accept", "start"], ["accept", "complete"],
    ["bytes", "start"], ["bytes", "complete"],
    ["file-end", "start"], ["file-end", "complete"],
  ] as const) {
    emitRelay(invocation, phase, status);
  }
  await stagePayload(invocation);
  emitRelay(invocation, "done", "complete");
  emitRelay(invocation, "teardown", "complete");
  return { files: [{ name: "pasted-secret.txt", bytes: invocation.files[0]?.size ?? 0, sha256: "stub" }], mode: "non-custodial" };
};

const stubFailingWebSender: WebSender = async (invocation) => {
  for (const [phase, status] of [
    ["ticket-request", "start"], ["ticket-request", "complete"],
    ["dht-connect", "start"], ["dht-connect", "complete"],
    ["bytes", "start"], ["bytes", "complete"],
  ] as const) {
    emitRelay(invocation, phase, status);
  }
  emitRelay(invocation, "done", "failed", { error: "Receiver did not confirm delivery in time" });
  throw new RelaySenderError({
    message: "Receiver did not confirm delivery in time",
    phase: "done",
    attempt: 1,
    mode: "non-custodial",
    connectionFailure: true,
  });
};

/** Stages the payload then fails at `done` — the late-delivery condition (bytes on wire). */
const stubLateDeliveryWebSender: WebSender = async (invocation) => {
  emitRelay(invocation, "bytes", "complete");
  await stagePayload(invocation);
  emitRelay(invocation, "done", "failed", { error: "Receiver did not confirm delivery in time" });
  throw new RelaySenderError({
    message: "Receiver did not confirm delivery in time",
    phase: "done",
    attempt: 1,
    mode: "non-custodial",
    connectionFailure: true,
  });
};

/** Hangs until the abort signal fires — for signal/timeout cleanup regression. */
const stubInterruptibleWebSender: WebSender = (invocation) =>
  new Promise((_resolve, reject) => {
    invocation.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  await rm(PAYLOAD_FILE, { force: true });
  await rm(PAYLOAD_PENDING_FILE, { force: true });
  await rm(CANCELLED_FILE, { force: true });
});

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

  it("drives the production web-sender boundary in-process and verifies exact disposable delivery", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "peardrop-nc-success-"));
    temporaryPaths.push(fixtureRoot);
    const binPath = join(fixtureRoot, "fixture.mjs");
    await writeFile(binPath, receiverFixture);
    const worker = await startWorkerDouble();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const summary = await runNcDiagnostic({
        binPath,
        timeoutMs: 5_000,
        workerUrl: worker.url,
        json: true,
        runWebSender: stubCompletingWebSender,
      });
      expect(summary).toMatchObject({
        status: "passed",
        phase: "complete",
        senderOutcome: "complete",
        senderExitCode: 0,
        receiverExitCode: 0,
        tunnelConsumed: true,
      });
      const events = output.flatMap((chunk) => chunk.trim().split("\n")).filter(Boolean).map((line) => JSON.parse(line) as { sequence: number; source: string; data: unknown });
      expect(events.map((event) => event.sequence)).toEqual(events.map((event) => event.sequence).sort((left, right) => left - right));
      // Web-sender relay-phase events route to source=relay; the invocation
      // envelope routes to source=web-sender — both labeled clearly.
      expect(events.some((event) => event.source === "relay")).toBe(true);
      expect(events.some((event) => event.source === "web-sender")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("owner-secret");
    } finally {
      await worker.close();
    }
  });

  it("retains the exact failed phase when the web sender fails and no late delivery occurs", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "peardrop-nc-failure-"));
    temporaryPaths.push(fixtureRoot);
    const binPath = join(fixtureRoot, "fixture.mjs");
    await writeFile(binPath, idleReceiverFixture);
    const worker = await startWorkerDouble();
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    try {
      let failure: NcDiagnosticError | undefined;
      try {
        await runNcDiagnostic({
          binPath,
          timeoutMs: 5_000,
          workerUrl: worker.url,
          json: true,
          runWebSender: stubFailingWebSender,
        });
      } catch (cause) {
        if (cause instanceof NcDiagnosticError) failure = cause;
        else throw cause;
      }
      expect(failure?.summary.phase).toBe("done");
      expect(failure?.summary.senderOutcome).toBe("failed");
      expect(failure?.summary.senderExitCode).toBe(1);
      expect(worker.requests).toContainEqual({
        method: "DELETE",
        url: "/api/tunnels/test-drop",
        authorization: "Bearer owner-secret",
      });
      expect(await exists(CANCELLED_FILE)).toBe(true);
      expect(failure?.summary.artifactPath).toBeDefined();
      const artifact = await readFile(failure!.summary.artifactPath!, "utf8");
      expect(artifact).toContain('"phase":"done"');
      expect(artifact).not.toContain("owner-secret");
      expect(artifact).toContain('"phase":"late-delivery-watch"');
      const artifactEvents = artifact.trim().split("\n").map((line) => JSON.parse(line) as { data: { event?: string; status?: string } });
      expect(artifactEvents.at(-1)?.data).toMatchObject({ event: "summary", status: "failed" });
      await rm(failure!.summary.artifactPath!, { force: true });
    } finally {
      await worker.close();
    }
  });

  it("turns RED on terminal inconsistency: late delivery arrives after the web sender reports failure", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "peardrop-nc-late-"));
    temporaryPaths.push(fixtureRoot);
    const binPath = join(fixtureRoot, "fixture.mjs");
    await writeFile(binPath, lateDeliveryReceiverFixture(250));
    const worker = await startWorkerDouble();
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    try {
      let failure: NcDiagnosticError | undefined;
      try {
        await runNcDiagnostic({
          binPath,
          timeoutMs: 5_000,
          workerUrl: worker.url,
          json: true,
          runWebSender: stubLateDeliveryWebSender,
        });
      } catch (cause) {
        if (cause instanceof NcDiagnosticError) failure = cause;
        else throw cause;
      }
      // RED: the diagnostic fails at `late-delivery`, not at `done`, proving
      // it caught the invisible live attempt that delivered after failure.
      expect(failure?.summary.phase).toBe("late-delivery");
      expect(failure?.summary.status).toBe("failed");
      expect(failure?.summary.error).toContain("terminal inconsistency");
      expect(failure?.summary.artifactPath).toBeDefined();
      const artifact = await readFile(failure!.summary.artifactPath!, "utf8");
      expect(artifact).toContain('"phase":"late-delivery"');
      expect(artifact).toContain('"event":"terminal-consistency"');
      expect(artifact).not.toContain("owner-secret");
      await rm(failure!.summary.artifactPath!, { force: true });
    } finally {
      await worker.close();
    }
  });

  it("enforces bounded cancellation: SIGINT aborts the web sender and tears down the receiver within bound", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "peardrop-nc-signal-"));
    temporaryPaths.push(fixtureRoot);
    const binPath = join(fixtureRoot, "fixture.mjs");
    await writeFile(binPath, idleReceiverFixture);
    const worker = await startWorkerDouble();
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    try {
      const diagnostic = runNcDiagnostic({
        binPath,
        timeoutMs: 30_000,
        workerUrl: worker.url,
        json: true,
        runWebSender: stubInterruptibleWebSender,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.emit("SIGINT", "SIGINT");
      let failure: NcDiagnosticError | undefined;
      try {
        await diagnostic;
      } catch (cause) {
        if (cause instanceof NcDiagnosticError) failure = cause;
        else throw cause;
      }
      expect(failure?.summary.phase).toBe("signal");
      expect(failure?.summary.senderOutcome).toBe("interrupted");
      expect(worker.requests).toContainEqual({
        method: "DELETE",
        url: "/api/tunnels/test-drop",
        authorization: "Bearer owner-secret",
      });
      expect(await exists(CANCELLED_FILE)).toBe(true);
    } finally {
      process.removeAllListeners("SIGINT");
      await worker.close();
    }
  });
});
