import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServer, DiskSink } from "../src/bridge/BridgeServer.js";
import { SLUG_PATTERN, isSlugFormat } from "../src/tunnel/slug.js";
import { decodeDropSpec, type DropSpec } from "../src/spec/dropSpec.js";

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

async function withSpecBridge(spec: DropSpec, run: (ctx: {
  port: number;
  slug: string;
  directory: string;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "peardrop-bridge-spec-"));
  const bridge = new BridgeServer({ sink: new DiskSink(`${directory}/`), targetPathLabel: directory, spec });
  try {
    const { port, slug } = await bridge.start();
    await run({ port, slug, directory });
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

describe("BridgeServer spec drop page — bare URLs linkify, hostile strings stay inert", () => {
  it("turns a bare https URL in the top-level description, the request copy, and a field description into a real anchor tag", async () => {
    const spec = decodeDropSpec({
      description: "Grab the deploy key from https://console.example.com/keys first.",
      copy: { request: "See https://docs.example.com/setup for context." },
      fields: [
        {
          name: "deploy_key",
          type: "secret",
          description: "Rotate it at https://console.example.com/keys/rotate if it's expired.",
        },
      ],
    });

    await withSpecBridge(spec, async ({ port, slug }) => {
      const page = await rawRequest(port, `/${slug}`);
      expect(page.status).toBe(200);

      // Top-level description and request copy are rendered server-side —
      // real anchor tags, not just the bare URL text.
      expect(page.body).toContain('<a href="https://console.example.com/keys" target="_blank" rel="noopener noreferrer">https://console.example.com/keys</a>');
      expect(page.body).toContain('<a href="https://docs.example.com/setup" target="_blank" rel="noopener noreferrer">https://docs.example.com/setup</a>');

      // The field description is built client-side (DOM nodes in the
      // embedded script), so its URL travels as plain JSON data — assert the
      // client-side linkify function that turns it into a real anchor is
      // actually present and wired to run over field.description.
      expect(page.body).toContain("function appendLinkified(container, text)");
      expect(page.body).toContain("appendLinkified(desc, field.description)");
      // And the raw data it operates on really does contain the field's URL.
      expect(page.body).toContain("https://console.example.com/keys/rotate");
    });
  });

  it("doesn't swallow trailing sentence punctuation into the href", async () => {
    const spec = decodeDropSpec({
      description: "Get the new key from https://console.example.com/keys. See the docs (https://docs.example.com/setup) for the format.",
      fields: [{ name: "value", type: "secret" }],
    });

    await withSpecBridge(spec, async ({ port, slug }) => {
      const page = await rawRequest(port, `/${slug}`);
      expect(page.status).toBe(200);

      // The period ending the first sentence is not part of the URL.
      expect(page.body).toContain('<a href="https://console.example.com/keys" target="_blank" rel="noopener noreferrer">https://console.example.com/keys</a>. See the docs');
      expect(page.body).not.toContain("keys.\" target");

      // A URL wrapped in parens keeps its own trailing paren out of the href
      // — it closes the surrounding sentence, not the URL — and the sentence
      // stays intact around the anchor.
      expect(page.body).toContain('(<a href="https://docs.example.com/setup" target="_blank" rel="noopener noreferrer">https://docs.example.com/setup</a>) for the format');
    });
  });

  it("keeps a real closing paren that's part of the URL itself", async () => {
    const spec = decodeDropSpec({
      description: "Docs: https://en.wikipedia.org/wiki/PearDrop_(software) has more.",
      fields: [{ name: "value", type: "secret" }],
    });

    await withSpecBridge(spec, async ({ port, slug }) => {
      const page = await rawRequest(port, `/${slug}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain('<a href="https://en.wikipedia.org/wiki/PearDrop_(software)" target="_blank" rel="noopener noreferrer">https://en.wikipedia.org/wiki/PearDrop_(software)</a> has more');
    });
  });

  it("keeps a hostile description string escaped and inert — no literal tag, no attribute breakout", async () => {
    const hostile = 'Click <script>alert(document.cookie)</script> or visit https://ok.example.com/"><img src=x onerror=alert(1)>';
    const spec = decodeDropSpec({
      description: hostile,
      fields: [{ name: "value", type: "secret" }],
    });

    await withSpecBridge(spec, async ({ port, slug }) => {
      const page = await rawRequest(port, `/${slug}`);
      expect(page.status).toBe(200);

      // The literal, unescaped hostile markup must never appear.
      expect(page.body).not.toContain("<script>alert(document.cookie)</script>");
      expect(page.body).not.toContain('<img src=x onerror=alert(1)>');
      // Its escaped form does — proof the string was processed, not dropped.
      expect(page.body).toContain("&lt;script&gt;alert(document.cookie)&lt;/script&gt;");
      // The URL segment still linkifies, but the regex's excluded character
      // class (no whitespace, <, >, ", ') means the match stops right before
      // the quote — the href is clean, and the attack payload that follows
      // renders as escaped, inert trailing text outside the anchor, never
      // inside the href attribute where it could break out.
      expect(page.body).toContain('<a href="https://ok.example.com/" target="_blank" rel="noopener noreferrer">https://ok.example.com/</a>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    });
  });

  it("a literal </script> in a field description can't prematurely close the embedded spec JSON's own script tag", async () => {
    // JSON.stringify never escapes "<" — embedding it raw in a <script> tag
    // means a string containing "</script>" closes that real tag early,
    // breaking the browser's HTML parser out of the JSON entirely into
    // whatever HTML follows. Found while testing the spec-description fix
    // above, not the thing that fix itself was about — a genuinely separate,
    // pre-existing gap in the same file.
    const spec = decodeDropSpec({
      fields: [{ name: "value", type: "secret", description: "</script><img src=x onerror=alert(document.domain)>" }],
    });

    await withSpecBridge(spec, async ({ port, slug }) => {
      const page = await rawRequest(port, `/${slug}`);
      expect(page.status).toBe(200);

      // The literal closing tag must never appear verbatim in the response —
      // that's the actual break-out vector.
      expect(page.body).not.toContain("</script><img");
      // The embedded JSON still round-trips the real description text once
      // parsed — this must be a hidden-from-the-parser encoding, not data
      // loss or corruption of what the client-side code receives. Only "<"
      // needs escaping (the parser looks for the literal "<" to recognize a
      // closing tag at all), so ">" stays literal — \u003c/script>, not
      // \u003c/script\u003e.
      expect(page.body).toContain("\\u003c/script>");
    });
  });
});
