import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// @peardrop/core publishes from dist/, which CI only builds after the test
// step, so resolve it from source here — the same aliasing the CLI's esbuild
// bundle already does. Without this, a test cannot import a command module.
export default defineConfig({
  resolve: {
    alias: {
      "@peardrop/core/node": fileURLToPath(new URL("../core/src/node.ts", import.meta.url)),
      "@peardrop/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
