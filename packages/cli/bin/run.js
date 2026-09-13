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

await run(normalizeCliArgv(process.argv.slice(2)), import.meta.url)
  .catch(async (error) => handle(error))
  .finally(async () => flush());
