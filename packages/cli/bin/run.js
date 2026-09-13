#!/usr/bin/env node
import { flush, handle, run } from "@oclif/core";
import { normalizeCliArgv } from "../dist/argv.js";

// Keep normal version stdout compatible and receiver JSON free of diagnostics.
if (process.argv.length === 3 && process.argv[2] === "--version") {
  const { installationDiagnostics } = await import("../dist/diagnostics/installation.js");
  process.stderr.write(await installationDiagnostics(process.argv[1]));
}

await run(normalizeCliArgv(process.argv.slice(2)), import.meta.url)
  .catch(async (error) => handle(error))
  .finally(async () => flush());
