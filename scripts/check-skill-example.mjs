import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skillPath = resolve(root, "skills/peardrop/SKILL.md");
const examplePath = resolve(root, "examples/google-oauth-client.toml");

const skillText = await readFile(skillPath, "utf8");
const exampleText = await readFile(examplePath, "utf8");

const fence = /```toml\n([\s\S]*?)```/.exec(skillText);
if (!fence) {
  process.stderr.write(`No \`\`\`toml fenced block found in ${skillPath}\n`);
  process.exitCode = 1;
} else {
  const inlined = fence[1];
  if (inlined !== exampleText) {
    process.stderr.write(
      `${skillPath}'s inline TOML has drifted from ${examplePath}.\n` +
      "Keep the fenced ```toml block in SKILL.md byte-identical to the example file — update whichever one is stale.\n"
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("Skill example check passed.\n");
  }
}
