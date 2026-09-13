import { it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installationDiagnostics } from "../src/diagnostics/installation.js";

it("identifies a stale PATH-first CLI without executing it (#89)", async () => {
  const root = await mkdtemp(join(tmpdir(), "peardrop-installations-"));
  try {
    for (const version of ["1.5.0", "1.6.0"]) {
      const directory = join(root, version);
      await mkdir(join(directory, "bin"), { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@peardrop/cli", version }));
      await writeFile(join(directory, "bin/run.js"), "#!/bin/sh\nexit 99\n");
      await chmod(join(directory, "bin/run.js"), 0o755);
      await symlink("bin/run.js", join(directory, "peardrop"));
    }
    const result = await installationDiagnostics(join(root, "1.6.0/peardrop"), ["1.5.0", "1.6.0"].map((v) => join(root, v)).join(delimiter));
    expect(result).toContain(`Bare peardrop on PATH: ${JSON.stringify(join(root, "1.5.0/peardrop"))} (version "1.5.0")`);
    expect(result).toContain(`Resolved executable: ${JSON.stringify(await realpath(join(root, "1.6.0/bin/run.js")))} (version "1.6.0")`);
    expect(result).toContain("npx --yes @peardrop/cli@latest");
  } finally { await rm(root, { recursive: true, force: true }); }
});
