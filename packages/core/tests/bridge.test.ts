import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServer, DiskSink } from "../src/bridge/BridgeServer.js";
import { SLUG_PATTERN, isSlugFormat } from "../src/tunnel/slug.js";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * node:http rather than fetch: the Host-header cases below need to send a Host
 * that undici refuses to let a caller set.
 */
function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function withBridge(run: (ctx: {
  port: number;
  url: string;
  token: string;
  slug: string;
  directory: string;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "peardrop-bridge-"));
  const bridge = new BridgeServer({ sink: new DiskSink(`${directory}/`), targetPathLabel: directory });
  const { url, port, token, slug } = await bridge.start();
  try {
    await run({ port, url, token, slug, directory });
  } finally {
    await bridge.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

const jsonPayload = (text: string) => {
  const buf = Buffer.from(text, "utf-8");
  return JSON.stringify({
    kind: "text",
    files: [{
      name: "secret.txt",
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      data: Array.from(buf),
    }],
  });
};

describe("BridgeServer local drop URL (#16)", () => {
  it("publishes a word-slug URL and keeps the token out of it", async () => {
    await withBridge(async ({ url, port, token, slug }) => {
      expect(url).toBe(`http://127.0.0.1:${port}/${slug}`);
      expect(isSlugFormat(slug)).toBe(true);
      expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[a-z]+-[a-z]+-[0-9a-hjkmnp-tv-z]{3}$`));
      expect(SLUG_PATTERN.test(slug)).toBe(true);
      // The old format put the raw single-use token in the fragment.
      expect(url).not.toContain("#");
      expect(url).not.toContain(token);
    });
  });

  it("serves the drop page on the slug path only", async () => {
    await withBridge(async ({ port, slug }) => {
      const onSlug = await rawRequest(port, `/${slug}`);
      expect(onSlug.status).toBe(200);
      expect(onSlug.body).toContain("PearDrop Drop Surface");

      expect((await rawRequest(port, `/${slug}/`)).status).toBe(200);
      expect((await rawRequest(port, "/")).status).toBe(404);
      expect((await rawRequest(port, "/index.html")).status).toBe(404);
      // Slug-shaped, but not this drop's slug (and not generatable — neither
      // word is in the corpus), so it must 404 like any other stray path.
      expect((await rawRequest(port, "/other-place-000")).status).toBe(404);
    });
  });

  it("hands the upload token to the page instead of leaking it cross-origin", async () => {
    await withBridge(async ({ port, slug, token }) => {
      const page = await rawRequest(port, `/${slug}`);
      expect(page.body).toContain(`<script id="peardrop-token" type="application/json">"${token}"</script>`);
      expect(page.headers["cache-control"]).toBe("no-store");
      // A wildcard CORS header would let any site read that token back out.
      expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  it("still gates uploads on the single-use token, not on the slug", async () => {
    await withBridge(async ({ port, token, directory }) => {
      const headers = { "Content-Type": "application/json" };
      const body = jsonPayload("real-secret");

      const wrongToken = await rawRequest(port, "/upload?token=nope", { method: "POST", headers, body });
      expect(wrongToken.status).toBe(401);

      const noToken = await rawRequest(port, "/upload", { method: "POST", headers, body });
      expect(noToken.status).toBe(401);

      const accepted = await rawRequest(port, `/upload?token=${token}`, { method: "POST", headers, body });
      expect(accepted.status).toBe(200);
      expect(await readFile(join(directory, "secret.txt"), "utf-8")).toBe("real-secret");

      const replay = await rawRequest(port, `/upload?token=${token}`, { method: "POST", headers, body });
      expect(replay.status).toBe(410);
    });
  });

  it("refuses loopback requests that arrive under an attacker-controlled hostname", async () => {
    await withBridge(async ({ port, slug }) => {
      // DNS rebinding: a name the attacker owns, pointed at 127.0.0.1.
      const rebound = await rawRequest(port, `/${slug}`, { headers: { Host: `drop.evil.example:${port}` } });
      expect(rebound.status).toBe(403);

      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
        const direct = await rawRequest(port, `/${slug}`, { headers: { Host: host } });
        expect(direct.status).toBe(200);
      }
    });
  });
});
