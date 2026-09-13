/**
 * Cached "a newer CLI exists" notice for bare invocations (#115). The registry
 * is asked at most once per day, in the background, and never on this command's
 * critical path: the notice printed now comes from the previous check's cache.
 * Disabled with PEARDROP_NO_UPDATE_CHECK=1 or in CI.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org/@peardrop/cli/latest";

interface Cache {
  readonly checkedAt: number;
  readonly version: string;
}

export const latestCachePath = (): string => join(homedir(), ".peardrop", "latest.json");

const isNewer = (candidate: string, current: string): boolean => {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};

async function readCache(path: string): Promise<Cache | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && "checkedAt" in parsed &&
      typeof parsed.version === "string" && typeof parsed.checkedAt === "number") return parsed as Cache;
  } catch {
    // no cache yet
  }
  return null;
}

/** Refreshes the cache from the registry with a short timeout. Errors are swallowed; offline is normal. */
export async function refreshLatestCache(path = latestCachePath(), fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    const res = await fetchImpl(REGISTRY, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string") return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ checkedAt: Date.now(), version: body.version }), { mode: 0o600 });
  } catch {
    // offline, blocked, or slow: try again next time
  }
}

/**
 * One stderr line when the cached latest version is newer than `current`, and a
 * background refresh when the cache is stale. Returns the notice (or undefined).
 */
/** The in-flight background refresh, if any, so a launcher can let it finish before exiting. */
export let pendingRefresh: Promise<void> = Promise.resolve();

export async function latestVersionNotice(current: string, options: { path?: string; env?: NodeJS.ProcessEnv; now?: number; refresh?: () => Promise<void> } = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.PEARDROP_NO_UPDATE_CHECK === "1" || env.CI) return undefined;
  const path = options.path ?? latestCachePath();
  const cache = await readCache(path);
  const now = options.now ?? Date.now();
  if (!cache || now - cache.checkedAt > CACHE_TTL_MS) {
    pendingRefresh = (options.refresh ?? (() => refreshLatestCache(path)))().catch(() => undefined);
  }
  if (cache && isNewer(cache.version, current)) {
    return `peardrop ${current} is out of date (${cache.version} is published). Use npx --yes @peardrop/cli@latest, or reinstall; an old CLI also carries an old agent skill.\n`;
  }
  return undefined;
}
