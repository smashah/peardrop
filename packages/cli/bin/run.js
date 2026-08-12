#!/usr/bin/env node
import { flush, handle, run } from "@oclif/core";
import { normalizeCliArgv } from "../dist/argv.js";

await run(normalizeCliArgv(process.argv.slice(2)), import.meta.url)
  .catch(async (error) => handle(error))
  .finally(async () => flush());
