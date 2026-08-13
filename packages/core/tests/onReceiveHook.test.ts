import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ON_RECEIVE_FILE_COUNT_ENV,
  ON_RECEIVE_FILE_PATHS_ENV,
  ON_RECEIVE_TARGET_PATH_ENV,
  PEARDROP_BUN_ENV,
  resolveBunFromEnv,
  runOnReceiveHook,
} from "../src/hooks/onReceive.js";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "hooks", "onReceive.ts");
const HOOK_SOURCE = await readFile(sourcePath, "utf8");

describe("runOnReceiveHook portability (no hardcoded Bun path)", () => {
  it("never references /opt/homebrew/bin/bun or any absolute Bun path", () => {
    expect(HOOK_SOURCE).not.toContain("/opt/homebrew/bin/bun");
    expect(HOOK_SOURCE).not.toContain("/usr/local/bin/bun");
    expect(HOOK_SOURCE).not.toContain("/Users/");
    expect(HOOK_SOURCE).not.toContain("~/.bun/bin/bun");
  });

  it("executes the hook through a shell so $PATH resolves the interpreter portably", () => {
    expect(HOOK_SOURCE).toContain("shell: true");
  });

  it("resolves Bun from the environment (PEARDROP_BUN > BUN > bare 'bun')", () => {
    expect(resolveBunFromEnv({})).toBe("bun");
    expect(resolveBunFromEnv({ BUN: "/custom/bun" })).toBe("/custom/bun");
    expect(resolveBunFromEnv({ BUN: "/custom/bun", PEARDROP_BUN: "/explicit/bun" })).toBe("/explicit/bun");
    // Empty/whitespace values are skipped, not silently used.
    expect(resolveBunFromEnv({ BUN: "  " })).toBe("bun");
    expect(resolveBunFromEnv({ PEARDROP_BUN: "\t" })).toBe("bun");
  });

  it("documents the env-var precedence and never hardcodes a fallback path", () => {
    expect(PEARDROP_BUN_ENV).toEqual(["PEARDROP_BUN", "BUN"]);
  });

  it("invokes a real hook portably through $PATH and surfaces its environment", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "peardrop-hook-portable-"));
    try {
      const targetPath = join(scratch, "inbox");
      // `true` is POSIX-portable and resolves via $PATH through the shell.
      const result = await runOnReceiveHook({
        command: "true",
        targetPath,
        files: [{ name: "secret.txt", path: join(targetPath, "secret.txt") }],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("passes drop paths via the documented environment variables, never via argv", () => {
    expect(HOOK_SOURCE).toContain(`[ON_RECEIVE_TARGET_PATH_ENV]: options.targetPath`);
    expect(HOOK_SOURCE).toContain(`[ON_RECEIVE_FILE_PATHS_ENV]: paths.join("\\n")`);
    expect(HOOK_SOURCE).toContain(`[ON_RECEIVE_FILE_COUNT_ENV]: String(paths.length)`);
    expect(ON_RECEIVE_TARGET_PATH_ENV).toBe("PEARDROP_TARGET_PATH");
    expect(ON_RECEIVE_FILE_PATHS_ENV).toBe("PEARDROP_FILE_PATHS");
    expect(ON_RECEIVE_FILE_COUNT_ENV).toBe("PEARDROP_FILE_COUNT");
  });
});
