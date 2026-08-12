import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { extname, relative, resolve } from "node:path";

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
const forbiddenTokens = [
  "@peardrop/" + "mcp",
  "../" + "mcp",
  "apps/" + "api",
  "apps/" + "webapp",
  "credentials." + "manifest",
  "owner" + "Auth",
  "peardrop.fyi.git",
];
for (const token of forbiddenTokens) {
  if (serializedManifest.includes(token)) throw new Error(`CLI manifest contains private token: ${token}`);
}

const extracted = resolve(artifacts, "extracted");
await mkdir(extracted, { recursive: true });
for (const archive of archives) {
  const destination = resolve(extracted, archive.replace(/\.tgz$/, ""));
  await mkdir(destination, { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", resolve(artifacts, archive), "-C", destination], { encoding: "utf8" });
  if (unpacked.status !== 0) {
    process.stderr.write(unpacked.stderr || unpacked.stdout);
    process.exit(unpacked.status ?? 1);
  }
}

const scannedExtensions = new Set([".cjs", ".js", ".json", ".mjs", ".ts"]);
const scan = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!scannedExtensions.has(extname(entry.name))) continue;
    const contents = await readFile(path, "utf8");
    for (const token of forbiddenTokens) {
      if (contents.includes(token)) throw new Error(`${relative(extracted, path)} contains private token: ${token}`);
    }
  }
};

await scan(extracted);

const installDirectory = resolve(artifacts, "install");
await mkdir(installDirectory, { recursive: true });
const initialize = spawnSync("npm", ["init", "--yes"], {
  cwd: installDirectory,
  encoding: "utf8",
});
if (initialize.status !== 0) {
  process.stderr.write(initialize.stderr || initialize.stdout);
  process.exit(initialize.status ?? 1);
}

const install = spawnSync(
  "npm",
  ["install", "--ignore-scripts", ...archives.map((archive) => resolve(artifacts, archive))],
  { cwd: installDirectory, encoding: "utf8" },
);
if (install.status !== 0) {
  process.stderr.write(install.stderr || install.stdout);
  process.exit(install.status ?? 1);
}

const cliHelp = spawnSync(resolve(installDirectory, "node_modules/.bin/peardrop"), ["--help"], {
  cwd: installDirectory,
  encoding: "utf8",
});
if (cliHelp.status !== 0) {
  process.stderr.write(cliHelp.stderr || cliHelp.stdout);
  process.exit(cliHelp.status ?? 1);
}
if (!cliHelp.stdout.includes("PearDrop")) {
  throw new Error("Installed peardrop executable did not render its help output");
}

const importCore = spawnSync(
  "node",
  ["--input-type=module", "--eval", 'await import("@peardrop/core"); await import("@peardrop/core/node");'],
  { cwd: installDirectory, encoding: "utf8" },
);
if (importCore.status !== 0) {
  process.stderr.write(importCore.stderr || importCore.stdout);
  process.exit(importCore.status ?? 1);
}

const browserEntry = resolve(installDirectory, "browser-relay-entry.mjs");
await writeFile(browserEntry, 'export { sendRelay } from "@peardrop/core/relay";\n');
const bundleRelay = spawnSync(
  resolve(root, "packages/cli/node_modules/.bin/esbuild"),
  [browserEntry, "--bundle", "--platform=browser", "--format=esm", `--outfile=${resolve(installDirectory, "browser-relay-bundle.mjs")}`],
  { cwd: root, encoding: "utf8" },
);
if (bundleRelay.status !== 0) {
  process.stderr.write(bundleRelay.stderr || bundleRelay.stdout);
  process.exit(bundleRelay.status ?? 1);
}

process.stdout.write(`Package install and smoke check passed: ${archives.join(", ")}\n`);
