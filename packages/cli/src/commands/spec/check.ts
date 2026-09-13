import { Command, Flags } from "@oclif/core";
import { DropSpecError } from "@peardrop/core";
import { describeSpec, formatSpecReport } from "../../specReport.js";
import { loadSpecFromFlags, specFlags } from "../../specFlags.js";

/** Deterministic page check: validates the spec and prints exactly what will render and be delivered. No tunnel, no browser. */
export default class SpecCheckCommand extends Command {
  static override description = "Validate a drop spec (TOML or inline flags) and print the fields, labels, links, and delivered filenames it will produce";

  static override examples = [
    "<%= config.bin %> spec check --spec ./drop.toml",
    '<%= config.bin %> spec check --field api_token:token:"API token" --field-link api_token=https://console.example.com/tokens',
  ];

  static override flags = {
    ...specFlags,
    json: Flags.boolean({ description: "Print the report as JSON" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(SpecCheckCommand);
    try {
      const loaded = loadSpecFromFlags(flags);
      if (!loaded) this.error("Pass --spec, --spec-inline, or inline --title/--field flags.", { exit: 1 });
      const report = describeSpec(loaded.spec);
      if (flags["print-spec"]) {
        this.log(loaded.toml);
        return;
      }
      this.log(flags.json ? JSON.stringify(report) : formatSpecReport(report));
    } catch (cause) {
      const message = cause instanceof DropSpecError ? cause.message : cause instanceof Error ? cause.message : String(cause);
      if (flags.json) this.log(JSON.stringify({ ok: false, error: message }));
      this.error(message, { exit: 1 });
    }
  }
}
