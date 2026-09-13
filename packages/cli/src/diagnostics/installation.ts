import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

interface Installation {
  path: string;
  executable: string;
  version: string | null;
}

// Read only the package manifest beside the executable. Never run another CLI:
// an old binary may not understand current flags or may launch a receiver.
async function installation(path: string): Promise<Installation | null> {
  try {
    await access(path, constants.X_OK);
    const executable = await realpath(path);
    const manifest: unknown = JSON.parse(await readFile(join(dirname(executable), "../package.json"), "utf8"));
    const version = typeof manifest === "object" && manifest !== null &&
      "name" in manifest && manifest.name === "@peardrop/cli" &&
      "version" in manifest && typeof manifest.version === "string"
      ? manifest.version : null;
    return { path: resolve(path), executable, version };
  } catch {
    // Shell wrappers and unmanaged binaries may have no adjacent manifest.
    try {
      await access(path, constants.X_OK);
      return { path: resolve(path), executable: await realpath(path), version: null };
    } catch {
      return null;
    }
  }
}

export async function installationDiagnostics(executable: string, searchPath = process.env.PATH ?? ""): Promise<string> {
  const active = await installation(executable);
  const lines = [
    `Invoked executable: ${JSON.stringify(active?.path ?? resolve(executable))}`,
    `Resolved executable: ${JSON.stringify(active?.executable ?? resolve(executable))} (version ${JSON.stringify(active?.version ?? "unknown")})`,
  ];
  const candidates = await Promise.all([...new Set(searchPath.split(delimiter))].map(
    (directory) => installation(join(directory || ".", process.platform === "win32" ? "peardrop.cmd" : "peardrop")),
  ));
  const first = candidates.find((candidate) => candidate !== null);
  if (first) lines.push(`Bare peardrop on PATH: ${JSON.stringify(first.path)} (version ${JSON.stringify(first.version ?? "unknown")})`);
  const seen = new Set([active?.executable]);
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.executable)) continue;
    seen.add(candidate.executable);
    lines.push(`Other PATH installation: ${JSON.stringify(candidate.path)} -> ${JSON.stringify(candidate.executable)} (version ${JSON.stringify(candidate.version ?? "unknown")})`);
  }
  if (candidates.some((candidate) => candidate && candidate.executable !== active?.executable)) {
    lines.push("Multiple installations found. Use npx --yes @peardrop/cli@latest for current flags; remove the obsolete installation or correct PATH, then run hash -r in your shell.");
  }
  return `${lines.join("\n")}\n`;
}
