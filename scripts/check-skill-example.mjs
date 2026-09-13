import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillPath = resolve(root, "skills/peardrop/SKILL.md");
const examplePath = resolve(root, "examples/google-oauth-client.toml");

const skillText = await readFile(skillPath, "utf8");
const exampleText = await readFile(examplePath, "utf8");
const tokenExample = await readFile(resolve(root, "examples/api-token.toml"), "utf8");
const cliReadme = await readFile(resolve(root, "packages/cli/README.md"), "utf8");

for (const [name, text] of [[skillPath, skillText], ["packages/cli/README.md", cliReadme]]) {
  const heredoc = /cat > \.\/drop\.toml <<'TOML'\n([\s\S]*?)\nTOML/.exec(text);
  if (!heredoc || `${heredoc[1]}\n` !== tokenExample) {
    process.stderr.write(`${name}'s one-token heredoc has drifted from examples/api-token.toml.\n`);
    process.exitCode = 1;
  }
}

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
