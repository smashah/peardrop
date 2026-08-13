import { Command, Flags } from "@oclif/core";
import { fileURLToPath } from "node:url";
import { NcDiagnosticError, parseBoundedTimeout, runNcDiagnostic } from "../../diagnostics/nc.js";

export default class TestNcCommand extends Command {
  static override description = "Run a disposable production non-custodial Relay diagnostic against the shared web-sender boundary";

  static override flags = {
    timeout: Flags.string({ description: "Bounded diagnostic timeout (5s to 2m)", default: "30s" }),
    json: Flags.boolean({ description: "Write structured diagnostic events and summary to stdout" }),
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi", hidden: true }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(TestNcCommand);
    let timeoutMs: number;
    try {
      timeoutMs = parseBoundedTimeout(flags.timeout);
    } catch (cause) {
      this.error(cause instanceof Error ? cause.message : String(cause));
    }
    const binPath = fileURLToPath(new URL("../../../bin/run.js", import.meta.url));
    try {
      await runNcDiagnostic({
        binPath,
        timeoutMs: timeoutMs!,
        workerUrl: flags["worker-url"],
        json: flags.json,
      });
    } catch (cause) {
      if (cause instanceof NcDiagnosticError) return this.exit(1);
      throw cause;
    }
  }
}
