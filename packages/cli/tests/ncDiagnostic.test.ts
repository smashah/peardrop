import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NcDiagnosticError, parseBoundedTimeout, redactDiagnosticValue, runNcDiagnostic } from "../src/diagnostics/nc.js";

const temporaryPaths: string[] = [];

const exists = async (path: string) => stat(path).then(() => true, () => false);

const startConsumedWorker = async () => {
  const requests: Array<{ method: string; url: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
    });
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test Worker did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const successFixture = String.raw`
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const waitFor = async (path) => { for (;;) { try { return await readFile(path, "utf8"); } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } } };
if (args[0] === "receive") {
  const target = args[args.indexOf("--target") + 1];
  await writeFile(join(root, "target"), target);
  console.log(JSON.stringify({ event: "session", tunnelId: "test-drop", ownerToken: "owner-secret", phase: "session" }));
  const payload = await waitFor(join(root, "payload"));
  await mkdir(target, { recursive: true });
  const path = join(target, "pasted-secret.txt");
  await writeFile(path, payload);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  console.log(JSON.stringify({ event: "connected", phase: "connected", transport: "hyperdht" }));
  console.log(JSON.stringify({ event: "delivered", phase: "delivered", files: [{ path, bytes: Buffer.byteLength(payload), sha256 }] }));
  await writeFile(join(root, "ack"), "ok");
  console.log(JSON.stringify({ event: "teardown", phase: "teardown", status: "complete" }));
} else {
  if (!args.includes("--relay") || !args.includes("--non-custodial-only")) {
    console.log(JSON.stringify({ event: "error", phase: "argv", status: "failed", error: "Relay force flags missing" }));
    process.exit(2);
  }
  const payload = args[args.indexOf("--text") + 1];
  console.log(JSON.stringify({ event: "relay", phase: "ticket-request", status: "complete", attempt: 1, mode: "non-custodial", transport: "relay" }));
  console.error("[relay] elapsedMs=2 pid=" + process.pid + " phase=dht-connect attempt=1 mode=non-custodial transport=relay status=complete");
  await writeFile(join(root, "payload"), payload);
  await waitFor(join(root, "ack"));
  console.log(JSON.stringify({ event: "delivered", phase: "done", transport: "relay", mode: "non-custodial" }));
}
`;

const failureFixture = String.raw`
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args[0] === "receive") {
  process.once("SIGTERM", () => setTimeout(async () => {
    await writeFile(join(root, "receiver-cancelled"), "yes");
    console.log(JSON.stringify({ event: "teardown", phase: "teardown", status: "cancelled" }));
    process.exit(0);
  }, 1500));
  console.log(JSON.stringify({ event: "session", tunnelId: "test-drop", ownerToken: "owner-secret", phase: "session" }));
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
} else {
  if (!args.includes("--relay") || !args.includes("--non-custodial-only")) {
    console.log(JSON.stringify({ event: "error", phase: "argv", status: "failed", error: "Relay force flags missing" }));
    process.exit(2);
  }
  console.log(JSON.stringify({ event: "error", phase: "dht-connect", status: "failed", transport: "relay", error: "synthetic failure" }));
  console.log(JSON.stringify({ event: "relay", phase: "teardown", status: "complete", transport: "relay" }));
  process.exit(1);
}
`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

  it("orchestrates real child processes and verifies exact disposable delivery", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "peardrop-nc-success-"));
    temporaryPaths.push(fixtureRoot);
    const binPath = join(fixtureRoot, "fixture.mjs");
    await writeFile(binPath, successFixture);
    const worker = await startConsumedWorker();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const summary = await runNcDiagnostic({ binPath, timeoutMs: 5_000, workerUrl: worker.url, json: true });
      expect(summary).toMatchObject({ status: "passed", phase: "complete", senderExitCode: 0, receiverExitCode: 0, tunnelConsumed: true });
      const events = output.flatMap((chunk) => chunk.trim().split("\n")).filter(Boolean).map((line) => JSON.parse(line) as { sequence: number; source: string; data: unknown });
      expect(events.map((event) => event.sequence)).toEqual(events.map((event) => event.sequence).sort((left, right) => left - right));
      expect(events.some((event) => event.source === "relay")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("owner-secret");
      const delivered = events.find((event) => JSON.stringify(event.data).includes("pasted-secret.txt"));
      const match = /\"path\":\"([^\"]+pasted-secret\.txt)\"/.exec(JSON.stringify(delivered?.data));
      expect(match?.[1]).toBeDefined();
      expect(await exists(match![1])).toBe(false);
    } finally {
      await worker.close();
    }
  });

  it("retains the exact failed phase and lets the receiver finish cancellation before force-kill", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "peardrop-nc-failure-"));
    temporaryPaths.push(fixtureRoot);
    const binPath = join(fixtureRoot, "fixture.mjs");
    await writeFile(binPath, failureFixture);
    const worker = await startConsumedWorker();
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    try {
      let failure: NcDiagnosticError | undefined;
      try {
        await runNcDiagnostic({ binPath, timeoutMs: 5_000, workerUrl: worker.url, json: true });
      } catch (cause) {
        if (cause instanceof NcDiagnosticError) failure = cause;
        else throw cause;
      }
      expect(failure?.summary.phase).toBe("dht-connect");
      expect(worker.requests).toContainEqual({
        method: "DELETE",
        url: "/api/tunnels/test-drop",
        authorization: "Bearer owner-secret",
      });
      expect(await exists(join(fixtureRoot, "receiver-cancelled"))).toBe(true);
      expect(failure?.summary.artifactPath).toBeDefined();
      const artifact = await readFile(failure!.summary.artifactPath!, "utf8");
      expect(artifact).toContain('"phase":"dht-connect"');
      expect(artifact).not.toContain("owner-secret");
      await rm(failure!.summary.artifactPath!, { force: true });
    } finally {
      await worker.close();
    }
  });
});
