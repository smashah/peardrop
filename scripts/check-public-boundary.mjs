import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowedTopLevel = new Set([
  ".bumpy",
  ".github",
  ".gitignore",
  ".npmrc",
  "AGENT_INSTRUCTIONS.md",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "apps",
  "infra",
  "package.json",
  "packages",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts",
  "skills",
  "tsconfig.json",
  "turbo.json",
]);
const forbiddenText = [
  "@peardrop/mcp",
  "../mcp",
  "apps/api",
  "apps/webapp",
  "credentials.manifest",
  "ownerAuth",
  "smashstack",
];
const scannedExtensions = new Set([".cjs", ".js", ".json", ".mjs", ".ts", ".yaml", ".yml"]);

const entries = await readdir(root, { withFileTypes: true });
const unexpected = entries
  .map((entry) => entry.name)
  .filter((name) => name !== ".git" && name !== "node_modules" && !allowedTopLevel.has(name));

const violations = unexpected.map((name) => `unexpected top-level path: ${name}`);

const scan = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const path = resolve(directory, entry.name);
    if (
      path === resolve(root, "scripts/check-public-boundary.mjs") ||
      path === resolve(root, "scripts/package-smoke.mjs")
    ) continue;
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!scannedExtensions.has(extname(entry.name))) continue;
    const contents = await readFile(path, "utf8");
    for (const token of forbiddenText) {
      if (contents.includes(token)) violations.push(`${relative(root, path)} contains ${token}`);
    }
  }
};

await scan(root);

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Public boundary check passed.\n");
}
