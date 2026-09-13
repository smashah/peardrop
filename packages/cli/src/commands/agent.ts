import { Command, Flags } from "@oclif/core";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// dist/commands/agent.js and src/commands/agent.ts both sit two levels below the
// package root; the build copies ../../skills into the package before publishing.
const packageRoot = resolve(here, "../..");
const skillCandidates = [join(packageRoot, "skills/peardrop"), resolve(packageRoot, "../../skills/peardrop")];

async function skillDirectory(): Promise<string> {
  for (const candidate of skillCandidates) {
    try {
      await access(join(candidate, "SKILL.md"));
      return candidate;
    } catch {
      // try the next location
    }
  }
  throw new Error("Bundled skill not found; reinstall @peardrop/cli.");
}

async function cliVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  return typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string"
    ? manifest.version
    : "unknown";
}

/** The complete agent context as one document: SKILL.md followed by every reference. */
export async function agentContext(): Promise<string> {
  const directory = await skillDirectory();
  const version = await cliVersion();
  const parts = [`<!-- @peardrop/cli ${version} agent context. Regenerate with: npx --yes @peardrop/cli@latest agent -->\n`];
  parts.push(await readFile(join(directory, "SKILL.md"), "utf8"));
  const referencesDirectory = join(directory, "references");
  let references: string[] = [];
  try {
    references = (await readdir(referencesDirectory)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    // a skill without references is fine
  }
  for (const name of references) {
    parts.push(`\n\n---\n\n<!-- references/${name} -->\n\n`);
    parts.push(await readFile(join(referencesDirectory, name), "utf8"));
  }
  return parts.join("");
}

/** Standard skill locations for the common agent harnesses. */
export function skillInstallTargets(scope: "user" | "project", home = homedir(), cwd = process.cwd()): string[] {
  return scope === "project"
    ? [join(cwd, ".claude/skills/peardrop"), join(cwd, ".agents/skills/peardrop")]
    : [join(home, ".claude/skills/peardrop"), join(home, ".agents/skills/peardrop")];
}

export async function installSkill(targets: string[], ledgerPath = join(homedir(), ".peardrop/skill-installs.json")): Promise<{ version: string; paths: string[] }> {
  const directory = await skillDirectory();
  const version = await cliVersion();
  for (const target of targets) {
    await mkdir(target, { recursive: true });
    await cp(directory, target, { recursive: true, force: true });
  }
  let ledger: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(ledgerPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) ledger = parsed as Record<string, string>;
  } catch {
    // first install
  }
  for (const target of targets) ledger[target] = version;
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  return { version, paths: targets };
}

export default class AgentCommand extends Command {
  static override description = "Print the complete PearDrop agent instructions (skill + references), or install them into your agent's skill directories";

  static override examples = [
    "<%= config.bin %> agent",
    "<%= config.bin %> agent --install",
    "<%= config.bin %> agent --install --project",
  ];

  static override flags = {
    install: Flags.boolean({ description: "Copy the bundled skill into ~/.claude/skills and ~/.agents/skills instead of printing it" }),
    project: Flags.boolean({ description: "With --install: write to ./.claude/skills and ./.agents/skills in the current project", dependsOn: ["install"] }),
    json: Flags.boolean({ description: "With --install: print the installed paths as JSON" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(AgentCommand);
    if (!flags.install) {
      this.log(await agentContext());
      return;
    }
    const result = await installSkill(skillInstallTargets(flags.project ? "project" : "user"));
    if (flags.json) {
      this.log(JSON.stringify(result));
      return;
    }
    for (const path of result.paths) this.log(`Installed PearDrop skill ${result.version} -> ${path}`);
  }
}
