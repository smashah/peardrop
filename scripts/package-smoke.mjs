import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, ".artifacts");
await rm(artifacts, { force: true, recursive: true });
await mkdir(artifacts, { recursive: true });

for (const packageDirectory of ["packages/core", "packages/cli"]) {
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", artifacts], {
    cwd: resolve(root, packageDirectory),
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    process.stderr.write(packed.stderr || packed.stdout);
    process.exit(packed.status ?? 1);
  }
}

const archives = await readdir(artifacts);
if (archives.length !== 2 || archives.some((name) => !name.endsWith(".tgz"))) {
  throw new Error(`Expected two package archives, found: ${archives.join(", ")}`);
}

const cliManifest = JSON.parse(await readFile(resolve(root, "packages/cli/package.json"), "utf8"));
const serializedManifest = JSON.stringify(cliManifest);
for (const token of ["@peardrop/mcp", "../mcp", "peardrop.fyi.git"]) {
  if (serializedManifest.includes(token)) throw new Error(`CLI manifest contains private token: ${token}`);
}

process.stdout.write(`Package smoke check passed: ${archives.join(", ")}\n`);
