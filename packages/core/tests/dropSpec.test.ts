import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServer, DiskSink } from "../src/bridge/BridgeServer.js";
import { DropSpecError, parseDropSpecToml } from "../src/spec/dropSpec.js";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures/specs", name), "utf-8");

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

const textValue = (text: string) => ({ kind: "text", text });
const fileValue = (files: Array<{ name: string; content: string }>) => ({
  kind: "file",
  files: files.map((f) => {
    const buf = Buffer.from(f.content, "utf-8");
    return { name: f.name, bytes: buf.length, sha256: sha256Hex(buf), data: Array.from(buf) };
  }),
});

async function withServer(
  specToml: string,
  run: (ctx: { submit: (values: Record<string, unknown>) => Promise<{ status: number; body: any }>; directory: string; getPage: () => Promise<string> }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "peardrop-spec-"));
  try {
    const spec = parseDropSpecToml(specToml);
    const bridge = new BridgeServer({ sink: new DiskSink(`${directory}/`), targetPathLabel: directory, spec });
    const { port, token } = await bridge.start();
    try {
      const submit = async (values: Record<string, unknown>) => {
        const res = await fetch(`http://127.0.0.1:${port}/upload?token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
          body: JSON.stringify({ values }),
        });
        return { status: res.status, body: await res.json() };
      };
      const getPage = async () => (await fetch(`http://127.0.0.1:${port}/`)).text();
      await run({ submit, directory, getPage });
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("DropSpec — variation matrix (peardrop.fyi#15)", () => {
  it("V1: single masked secret, default copy — required error then successful delivery", async () => {
    await withServer(fixture("v1-single-secret.toml"), async ({ submit, directory }) => {
      const missing = await submit({});
      expect(missing.status).toBe(422);
      expect(missing.body.errors.api_key).toBe("This field is required.");

      const ok = await submit({ api_key: textValue("sk-abc123") });
      expect(ok.status).toBe(200);
      expect(ok.body.ok).toBe(true);
      const content = await readFile(join(directory, "api_key.txt"), "utf-8");
      expect(content).toBe("sk-abc123");
    });
  });

  it("V2: multi-field two secrets + one text field, field order respected", async () => {
    const spec = parseDropSpecToml(fixture("v2-multi-field.toml"));
    expect(spec.fields.map((f) => f.name)).toEqual(["token", "account_id", "note"]);

    await withServer(fixture("v2-multi-field.toml"), async ({ submit, directory }) => {
      const ok = await submit({ token: textValue("tok-1"), account_id: textValue("acct-9") });
      expect(ok.status).toBe(200);
      await expect(readFile(join(directory, "token.txt"), "utf-8")).resolves.toBe("tok-1");
      await expect(readFile(join(directory, "account_id.txt"), "utf-8")).resolves.toBe("acct-9");
      const entries = await readdir(directory);
      expect(entries).not.toContain("note.txt");
    });
  });

  it("V3: file + text mixed page delivers both with field-prefixed filenames", async () => {
    await withServer(fixture("v3-file-and-text.toml"), async ({ submit, directory }) => {
      const ok = await submit({
        screenshot: fileValue([{ name: "capture.png", content: "fake-png-bytes" }]),
        caption: textValue("looks off"),
      });
      expect(ok.status).toBe(200);
      await expect(readFile(join(directory, "screenshot-capture.png"), "utf-8")).resolves.toBe("fake-png-bytes");
      await expect(readFile(join(directory, "caption.txt"), "utf-8")).resolves.toBe("looks off");
    });
  });

  it("V4: full copy override renders custom strings; unrelated defaults (field.required) still apply", async () => {
    const spec = parseDropSpecToml(fixture("v4-copy-override.toml"));
    expect(spec.copy.request).toBe("Paste the new deploy key below.");
    expect(spec.copy.success).toBe("Deploy key rotated — pipeline will pick it up on the next run.");
    expect(spec.copy.failure).toBe("Rotation failed — check the value and try again.");
    expect(spec.fields[0]!.required).toBe(true); // not set in fixture, default still applies

    await withServer(fixture("v4-copy-override.toml"), async ({ getPage }) => {
      const html = await getPage();
      expect(html).toContain("Paste the new deploy key below.");
      expect(html).toContain("Deploy key rotated");
    });
  });

  it("V5: regex + min-length validation — default messages, then a field-level override renders instead", async () => {
    await withServer(fixture("v5-validation-rules.toml"), async ({ submit }) => {
      const invalid = await submit({ api_key: textValue("not-a-key"), workspace_slug: textValue("abc") });
      expect(invalid.status).toBe(422);
      expect(invalid.body.errors.api_key).toBe("This value doesn't match the expected format.");
      // workspace_slug has an explicit `message` override in the fixture
      expect(invalid.body.errors.workspace_slug).toBe("Workspace slug looks too short — double-check it.");

      const ok = await submit({ api_key: textValue("sk-validKey1"), workspace_slug: textValue("acme-hq") });
      expect(ok.status).toBe(200);
    });
  });

  it("V6: quantity — expected file count enforced before submit is accepted", async () => {
    await withServer(fixture("v6-quantity.toml"), async ({ submit, directory }) => {
      const tooFew = await submit({
        receipts: fileValue([{ name: "one.pdf", content: "pdf-1" }]),
        expense_code: textValue("EXP-1"),
      });
      expect(tooFew.status).toBe(422);
      expect(tooFew.body.errors.receipts).toBe("Expected exactly 2 files.");

      const missingRequired = await submit({ receipts: fileValue([{ name: "one.pdf", content: "pdf-1" }, { name: "two.pdf", content: "pdf-2" }]) });
      expect(missingRequired.status).toBe(422);
      expect(missingRequired.body.errors.expense_code).toBe("This field is required.");

      const ok = await submit({
        receipts: fileValue([{ name: "one.pdf", content: "pdf-1" }, { name: "two.pdf", content: "pdf-2" }]),
        expense_code: textValue("EXP-1"),
      });
      expect(ok.status).toBe(200);
      await expect(readFile(join(directory, "receipts-0-one.pdf"), "utf-8")).resolves.toBe("pdf-1");
      await expect(readFile(join(directory, "receipts-1-two.pdf"), "utf-8")).resolves.toBe("pdf-2");
    });
  });

  it("V7: malformed TOML fails clearly before any server starts", () => {
    expect(() => parseDropSpecToml(fixture("v7-malformed.toml"))).toThrow(DropSpecError);
    try {
      parseDropSpecToml(fixture("v7-malformed.toml"));
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(DropSpecError);
      expect((cause as InstanceType<typeof DropSpecError>).message).toContain("Malformed TOML");
    }
  });

  it("a failed validation leaves the single-use token live for a resubmission", async () => {
    await withServer(fixture("v1-single-secret.toml"), async ({ submit }) => {
      const first = await submit({});
      expect(first.status).toBe(422);
      const second = await submit({ api_key: textValue("sk-retry-after-fix") });
      expect(second.status).toBe(200);
    });
  });
});
