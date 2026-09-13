import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentContext, installSkill, skillInstallTargets } from "../src/commands/agent.js";

describe("peardrop agent", () => {
  it("prints the skill and every reference as one document, stamped with the CLI version", async () => {
    const text = await agentContext();
    expect(text).toMatch(/^<!-- @peardrop\/cli \d+\.\d+\.\d+ agent context/);
    expect(text).toContain("name: peardrop");
    expect(text).toContain("## Create a drop");
    expect(text).toContain("<!-- references/config-and-handoff.md -->");
    expect(text).not.toMatch(/playwright|Tier 2|Pre-handoff receipt|Render an identical disposable/);
  });

  it("installs into the user or project skill directories and records the version", async () => {
    const root = await mkdtemp(join(tmpdir(), "peardrop-agent-"));
    try {
      const targets = skillInstallTargets("project", root, root);
      expect(targets).toEqual([join(root, ".claude/skills/peardrop"), join(root, ".agents/skills/peardrop")]);
      const ledger = join(root, "skill-installs.json");
      const result = await installSkill(targets, ledger);
      for (const target of targets) {
        expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("## Create a drop");
        expect(await readFile(join(target, "references/config-and-handoff.md"), "utf8")).toContain("Hook contract");
      }
      const recorded = JSON.parse(await readFile(ledger, "utf8")) as Record<string, string>;
      expect(recorded[targets[0]]).toBe(result.version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
