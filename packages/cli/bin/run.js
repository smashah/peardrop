#!/usr/bin/env node
import { flush, handle, run } from "@oclif/core";
import { normalizeCliArgv } from "../dist/argv.js";

// Keep normal version stdout compatible and receiver JSON free of diagnostics.
// Only speak up when it matters: a second installation on PATH. `peardrop doctor` has the full picture.
if (process.argv.length === 3 && process.argv[2] === "--version") {
  const { installationDiagnostics } = await import("../dist/diagnostics/installation.js");
  const diagnostics = await installationDiagnostics(process.argv[1]);
  if (diagnostics.includes("Multiple installations found")) process.stderr.write(diagnostics);
}

// A stale global is the worst case for agents (#115): say so once per day, from cache, never on the critical path.
let settleRefresh = async () => {};
try {
  const latest = await import("../dist/diagnostics/latest.js");
  const { createRequire } = await import("node:module");
  const { version } = createRequire(import.meta.url)("../package.json");
  const notice = await latest.latestVersionNotice(version);
  if (notice) process.stderr.write(notice);
  // The daily registry refresh runs alongside the command; give it at most 2.5 s to land after the command ends.
  settleRefresh = () => Promise.race([latest.pendingRefresh, new Promise((resolve) => setTimeout(resolve, 2_500).unref())]);
} catch {
  // never let the notice break a command
}

await run(normalizeCliArgv(process.argv.slice(2)), import.meta.url)
  .catch(async (error) => handle(error))
  .finally(async () => { await settleRefresh(); await flush(); });
