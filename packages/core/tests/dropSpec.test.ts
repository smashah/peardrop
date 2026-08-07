import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { BridgeServer, DiskSink, type BridgeOnReceiveHook } from "../src/bridge/BridgeServer.js";
import { DropSpecError, parseDropSpecToml } from "../src/spec/dropSpec.js";
import type { OnReceiveHookResult } from "../src/hooks/onReceive.js";

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

interface ServerContext {
  submit: (values: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  directory: string;
  getPage: () => Promise<string>;
  /** Resolves once delivery *and* any post-receive hook have finished. */
  awaitClosed: () => Promise<"delivered" | "failed">;
  hookResult: () => OnReceiveHookResult | null;
}

async function withServer(
  specToml: string,
  run: (ctx: ServerContext) => Promise<void>,
  hookOptions?: { onReceive?: (directory: string) => BridgeOnReceiveHook; hookLog?: (chunk: string) => void }
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "peardrop-spec-"));
  try {
    const spec = parseDropSpecToml(specToml);
    const onReceive = hookOptions?.onReceive?.(directory)
      ?? (spec.hooks.on_receive ? { command: spec.hooks.on_receive, targetPath: directory } : undefined);
    const bridge = new BridgeServer({
      sink: new DiskSink(`${directory}/`),
      targetPathLabel: directory,
      spec,
      onReceive,
      hookLog: hookOptions?.hookLog,
    });
    const { port, token, slug } = await bridge.start();
    try {
      const submit = async (values: Record<string, unknown>) => {
        const res = await fetch(`http://127.0.0.1:${port}/upload?token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
          body: JSON.stringify({ values }),
        });
        return { status: res.status, body: await res.json() };
      };
      // The drop page lives on the word-slug path now, not on the root.
      const getPage = async () => (await fetch(`http://127.0.0.1:${port}/${slug}`)).text();
      const awaitClosed = () => Effect.runPromise(bridge.awaitCompletion());
      await run({ submit, directory, getPage, awaitClosed, hookResult: () => bridge.hookResult() });
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

  it("V8: [hooks] on_receive runs after the write lands, with the paths in the environment", async () => {
    await withServer(fixture("v8-on-receive-hook.toml"), async ({ submit, directory, awaitClosed, hookResult }) => {
      const ok = await submit({ signing_key: textValue("sk-super-secret-value") });
      expect(ok.status).toBe(200);
      expect(await awaitClosed()).toBe("delivered");

      expect(hookResult()).toEqual({ ok: true, exitCode: 0, signal: null });

      const marker = (await readFile(join(directory, "hook-marker.txt"), "utf-8")).trim().split("\n");
      expect(marker[0]).toBe(directory); // PEARDROP_TARGET_PATH
      expect(marker[1]).toBe("1"); // PEARDROP_FILE_COUNT
      expect(marker[2]).toBe(join(directory, "signing_key.txt")); // PEARDROP_FILE_PATHS

      // The delivered secret is untouched by the hook running.
      await expect(readFile(join(directory, "signing_key.txt"), "utf-8")).resolves.toBe("sk-super-secret-value");
    });
  });

  it("V8: the hook process's own command line carries no secret value", async () => {
    await withServer(fixture("v8-on-receive-hook.toml"), async ({ submit, directory, awaitClosed }) => {
      expect((await submit({ signing_key: textValue("sk-super-secret-value") })).status).toBe(200);
      await awaitClosed();

      // `ps -o args= -p $$` inside the hook captures the full argv of the process
      // PearDrop spawned — the secret must reach it only via the written file.
      const argv = await readFile(join(directory, "hook-argv.txt"), "utf-8");
      expect(argv).not.toContain("sk-super-secret-value");
      expect(argv).toContain("PEARDROP_TARGET_PATH");
    });
  });

  it("V8: a non-zero hook exit is reported but leaves the delivered secret in place", async () => {
    const logged: string[] = [];
    await withServer(
      fixture("v1-single-secret.toml"),
      async ({ submit, directory, awaitClosed, hookResult }) => {
        const ok = await submit({ api_key: textValue("sk-still-delivered") });
        expect(ok.status).toBe(200);
        expect(ok.body.ok).toBe(true);
        expect(await awaitClosed()).toBe("delivered");

        expect(hookResult()).toMatchObject({ ok: false, exitCode: 3 });
        expect(logged.join("")).toContain("on_receive hook failed (exit code 3)");
        // The drop is not a transaction with the hook: the secret stays written.
        await expect(readFile(join(directory, "api_key.txt"), "utf-8")).resolves.toBe("sk-still-delivered");
      },
      { onReceive: (directory) => ({ command: "exit 3", targetPath: directory }), hookLog: (chunk) => logged.push(chunk) }
    );
  });

  it("V8: a spec with no [hooks] block runs no hook at all", async () => {
    const spec = parseDropSpecToml(fixture("v1-single-secret.toml"));
    expect(spec.hooks).toEqual({});

    await withServer(fixture("v1-single-secret.toml"), async ({ submit, awaitClosed, hookResult }) => {
      expect((await submit({ api_key: textValue("sk-no-hook") })).status).toBe(200);
      await awaitClosed();
      expect(hookResult()).toBeNull();
    });
  });

  it("V8: an empty on_receive command is rejected before any server starts", () => {
    const spec = parseDropSpecToml(fixture("v8-on-receive-hook.toml"));
    expect(spec.hooks.on_receive).toContain("PEARDROP_TARGET_PATH");

    expect(() => parseDropSpecToml('title = "x"\n\n[hooks]\non_receive = "   "\n\n[[fields]]\nname = "k"\ntype = "secret"\n')).toThrow(
      DropSpecError
    );
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
