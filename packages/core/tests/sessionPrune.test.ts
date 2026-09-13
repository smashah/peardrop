import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { pruneStaleSessions, sessionsDir, type TunnelSession } from "../src/session/SessionStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

let home: string;
let previousHome: string | undefined;

const writeSession = (
  tunnelId: string,
  overrides: Partial<TunnelSession>,
  options: { readonly mtimeMs?: number } = {}
): string => {
  const session: TunnelSession = {
    tunnelId,
    url: `https://peardrop.fyi/d/${tunnelId}`,
    fingerprint: "ABCDE-FGHIJ",
    target: "./peardrop-inbox/",
    expiresAt: NOW + 3600_000,
    relayAllowed: true,
    mode: "remote",
    status: "waiting",
    ...overrides,
  };
  const file = join(sessionsDir(), `${tunnelId}.json`);
  writeFileSync(file, JSON.stringify(session, null, 2));
  if (options.mtimeMs !== undefined) {
    const seconds = options.mtimeMs / 1000;
    utimesSync(file, seconds, seconds);
  }
  return file;
};

// The sweep asks the OS whether a pid is alive; these stubs stand in for that so
// the test never depends on a real process being (or not being) around.
const dead = () => false;
const living = () => true;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "peardrop-prune-"));
  previousHome = process.env.PEARDROP_HOME;
  process.env.PEARDROP_HOME = home;
  mkdirSync(sessionsDir(), { recursive: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PEARDROP_HOME;
  else process.env.PEARDROP_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("pruneStaleSessions", () => {
  it("removes a waiting session whose TTL has passed and whose receiver is gone", async () => {
    const file = writeSession("dead-and-expired", { expiresAt: NOW - 60_000, pid: 4242 });
    const result = await Effect.runPromise(pruneStaleSessions({ now: NOW, isAlive: dead }));
    expect(result).toEqual({ scanned: 1, pruned: 1 });
    expect(existsSync(file)).toBe(false);
  });

  it("never touches a session whose receiver is still running, expired or not", async () => {
    const file = writeSession("still-receiving", { expiresAt: NOW - 60_000, pid: 4242 });
    const result = await Effect.runPromise(pruneStaleSessions({ now: NOW, isAlive: living }));
    expect(result).toEqual({ scanned: 1, pruned: 0 });
    expect(existsSync(file)).toBe(true);
  });

  it("keeps a waiting session that has not expired yet", async () => {
    const file = writeSession("still-open", { expiresAt: NOW + 30 * 60_000, pid: 4242 });
    const result = await Effect.runPromise(pruneStaleSessions({ now: NOW, isAlive: dead }));
    expect(result).toEqual({ scanned: 1, pruned: 0 });
    expect(existsSync(file)).toBe(true);
  });

  it("removes a delivered session whose file has sat untouched for over a week", async () => {
    const file = writeSession(
      "delivered-last-week",
      { status: "delivered", expiresAt: NOW - 8 * DAY_MS },
      { mtimeMs: NOW - 8 * DAY_MS }
    );
    const result = await Effect.runPromise(pruneStaleSessions({ now: NOW, isAlive: dead }));
    expect(result).toEqual({ scanned: 1, pruned: 1 });
    expect(existsSync(file)).toBe(false);
  });

  it("keeps a freshly delivered session so status can still explain what happened", async () => {
    const file = writeSession(
      "delivered-just-now",
      { status: "delivered", expiresAt: NOW - 60_000 },
      { mtimeMs: NOW - 60_000 }
    );
    const result = await Effect.runPromise(pruneStaleSessions({ now: NOW, isAlive: dead }));
    expect(result).toEqual({ scanned: 1, pruned: 0 });
    expect(existsSync(file)).toBe(true);
  });

  it("counts without deleting under dryRun, which is how doctor reports stale sessions", async () => {
    const file = writeSession("dead-and-expired", { expiresAt: NOW - 60_000, pid: 4242 });
    const result = await Effect.runPromise(pruneStaleSessions({ now: NOW, isAlive: dead, dryRun: true }));
    expect(result).toEqual({ scanned: 1, pruned: 1 });
    expect(existsSync(file)).toBe(true);
  });

  it("leaves a half-written session file alone rather than destroying evidence", async () => {
    const file = join(sessionsDir(), "torn.json");
    writeFileSync(file, '{"tunnelId":"torn","status":"wait');
    const result = await Effect.runPromise(pruneStaleSessions({ now: NOW, isAlive: dead }));
    expect(result).toEqual({ scanned: 1, pruned: 0 });
    expect(existsSync(file)).toBe(true);
  });
});
