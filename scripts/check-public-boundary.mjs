import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowedFiles = new Set([
  ".dockerignore",
  ".gitignore",
  ".npmrc",
  "AGENT_INSTRUCTIONS.md",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "docs/RELEASING.md",
  "fly.toml",
  "infra/relay/Dockerfile",
  "infra/relay/compose.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/check-public-boundary.mjs",
  "scripts/check-release-contract.mjs",
  "scripts/package-smoke.mjs",
  "skills/peardrop/SKILL.md",
  "tsconfig.json",
  "turbo.json",
]);
const allowedPrefixes = [".bumpy/", ".github/workflows/", "apps/relay/", "packages/cli/", "packages/core/", "patches/"];
const forbiddenText = [
  "@peardrop/" + "mcp",
  "../" + "mcp",
  "apps/" + "api",
  "apps/" + "webapp",
  "credentials." + "manifest",
  "owner" + "Auth",
  "smash" + "stack",
];
const ignoredGeneratedPaths = new Set([".artifacts", ".git", ".turbo", "node_modules"]);
const violations = [];

const scan = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredGeneratedPaths.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    const repositoryPath = relative(root, path);
    const isAllowed = allowedFiles.has(repositoryPath) || allowedPrefixes.some((prefix) => repositoryPath.startsWith(prefix));
    if (!isAllowed) {
      violations.push(`unexpected public path: ${repositoryPath}`);
      continue;
    }
    const contents = await readFile(path, "utf8");
    for (const token of forbiddenText) {
      if (contents.includes(token)) violations.push(`${repositoryPath} contains ${token}`);
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
