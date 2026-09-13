import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestVersionNotice, refreshLatestCache } from "../src/diagnostics/latest.js";

describe("latest-version notice", () => {
  it("warns from the cache only, refreshes in the background when stale, and respects opt-out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peardrop-latest-"));
    try {
      const path = join(dir, "latest.json");
      let refreshed = 0;
      const refresh = async () => { refreshed += 1; };
      expect(await latestVersionNotice("1.7.0", { path, env: {}, refresh })).toBeUndefined();
      expect(refreshed).toBe(1);
      await writeFile(path, JSON.stringify({ checkedAt: Date.now(), version: "1.8.0" }));
      const notice = await latestVersionNotice("1.7.0", { path, env: {}, refresh });
      expect(notice).toContain("1.7.0 is out of date (1.8.0");
      expect(refreshed).toBe(1);
      expect(await latestVersionNotice("1.8.0", { path, env: {}, refresh })).toBeUndefined();
      expect(await latestVersionNotice("1.7.0", { path, env: { PEARDROP_NO_UPDATE_CHECK: "1" }, refresh })).toBeUndefined();
      await writeFile(path, JSON.stringify({ checkedAt: Date.now() - 48 * 3600 * 1000, version: "1.8.0" }));
      await latestVersionNotice("1.7.0", { path, env: {}, refresh });
      expect(refreshed).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the registry version to the cache and swallows failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peardrop-latest-"));
    try {
      const path = join(dir, "latest.json");
      await refreshLatestCache(path, (async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) })) as unknown as typeof fetch);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: "9.9.9" });
      await refreshLatestCache(path, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: "9.9.9" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
