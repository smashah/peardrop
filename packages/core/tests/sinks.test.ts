import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSinkTarget, parseSinkSpec, preflightSink, removeFromSink, runSinks, sinksKeepPlaintext, storeToSink } from "../src/hooks/sinks.js";

describe("storage sinks", () => {
  it("parses kind and options and rejects unknown ones", () => {
    expect(parseSinkSpec("keychain:service=starling.pat,account=me")).toMatchObject({ kind: "keychain", options: { service: "starling.pat", account: "me" } });
    expect(parseSinkSpec("file").kind).toBe("file");
    expect(() => parseSinkSpec("vault:x=1")).toThrow(/Unknown sink/);
    expect(() => parseSinkSpec("1password:item=x")).toThrow(/needs vault/);
    expect(() => parseSinkSpec("keychain:folder=x")).toThrow(/does not take/);
    expect(sinksKeepPlaintext([parseSinkSpec("file"), parseSinkSpec("keychain")])).toBe(true);
    expect(describeSinkTarget(parseSinkSpec("keychain:service=x.{field},account=me"), "pat", "-t")).toBe("Keychain service x.pat-t account me");
  });

  it("env-file sink: preflight, store (replace or append), ledger, plaintext removal, remove", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peardrop-sinks-"));
    try {
      const env = join(dir, ".env");
      writeFileSync(env, "OTHER=1\nSTARLING_PAT='old'\n");
      const sink = parseSinkSpec(`env-file:path=${env}`);
      expect((await preflightSink(sink)).ok).toBe(true);
      const delivered = join(dir, "starling_pat.txt");
      writeFileSync(delivered, "it's-a-secret\n", { mode: 0o600 });
      const ledger = join(dir, "ledger.jsonl");
      const results = await runSinks({ sinks: [sink], files: [{ name: "starling_pat.txt", path: delivered }], ledgerPath: ledger, tunnelId: "t1" });
      expect(results.map((r) => [r.sink, r.ok])).toEqual([["env-file", true], ["file", true]]);
      expect(readFileSync(env, "utf8")).toBe("OTHER=1\nSTARLING_PAT='it'\\''s-a-secret'\n");
      expect(existsSync(delivered)).toBe(false);
      const row = JSON.parse(readFileSync(ledger, "utf8").trim()) as Record<string, unknown>;
      expect(row).toMatchObject({ tunnelId: "t1", field: "starling_pat", sink: "env-file", ok: true });
      expect(JSON.stringify(row)).not.toContain("secret");
      expect((await storeToSink(sink, { field: "other_key", value: "v", suffix: "-test" })).detail).toContain("OTHER_KEY_TEST");
      await removeFromSink(sink, { field: "starling_pat" });
      expect(readFileSync(env, "utf8")).not.toContain("STARLING_PAT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the plaintext when a sink fails, so the only copy of the secret survives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peardrop-sinks-"));
    try {
      const unwritable = join(dir, "missing-dir", ".env");
      const sink = parseSinkSpec(`env-file:path=${unwritable}`);
      const delivered = join(dir, "pat.txt");
      writeFileSync(delivered, "secret\n", { mode: 0o600 });
      const results = await runSinks({ sinks: [sink], files: [{ name: "pat.txt", path: delivered }], ledgerPath: join(dir, "ledger.jsonl") });
      expect(results.map((r) => [r.sink, r.ok])).toEqual([["env-file", false], ["file", false]]);
      expect(existsSync(delivered)).toBe(true);
      expect(results[1]?.detail).toContain("kept because a sink failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin" || process.env.CI)("keychain sink: store via stdin, verify, remove", async () => {
    const sink = parseSinkSpec("keychain:service=peardrop.test.{field}");
    const stored = await storeToSink(sink, { field: "unit", value: 'va"lue\\x', suffix: "-t" });
    expect(stored.ok, stored.detail).toBe(true);
    const removed = await removeFromSink(sink, { field: "unit", suffix: "-t" });
    expect(removed.ok).toBe(true);
  });
});
