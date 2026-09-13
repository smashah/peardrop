import { Command, Flags } from "@oclif/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DropSpecError } from "@peardrop/core";
import { parseSinkSpec, preflightSink, removeFromSink, runOnReceiveHook, runSinks, SinkError, type SinkResult, type SinkSpec } from "@peardrop/core/node";
import { loadSpecFromFlags, specFlags } from "../../specFlags.js";

/**
 * Dry-runs the storage side of a drop without a tunnel: preflights every sink,
 * fabricates 0600 delivery files with dummy values, stores them under
 * test-suffixed names, removes them again, and optionally runs the on_receive
 * hook against the fake files. This is the only verification a routine drop
 * needs before its URL is shared.
 */
export default class HookTestCommand extends Command {
  static override description = "Dry-run the --store sinks (and optionally the on_receive hook) with fake delivery files, then clean up";

  static override examples = [
    '<%= config.bin %> hook test --field starling_pat:token --store keychain:service=starling.pat --store "passbolt:name=Starling PAT,folder=<id>"',
    "<%= config.bin %> hook test --spec ./drop.toml --store env-file:path=./.env --run-hook",
  ];

  static override flags = {
    ...specFlags,
    store: Flags.string({ multiple: true, description: "Sink to test, e.g. keychain:service=x, passbolt:folder=<id>, 1password:vault=V, env-file:path=./.env" }),
    "on-receive": Flags.string({ description: "Hook command to run against the fake files (needs --run-hook)" }),
    "run-hook": Flags.boolean({ description: "Also run the on_receive hook (from the spec or --on-receive) against the fake delivery files" }),
    json: Flags.boolean({ description: "One JSON line per result" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(HookTestCommand);
    let fields = ["secret"];
    let hook = flags["on-receive"];
    let sinks: SinkSpec[] = [];
    try {
      const loaded = loadSpecFromFlags(flags);
      if (loaded) {
        fields = loaded.spec.fields.filter((f) => f.type !== "file").map((f) => f.name);
        hook ??= loaded.spec.hooks.on_receive;
      }
      sinks = (flags.store ?? []).map(parseSinkSpec);
    } catch (cause) {
      const message = cause instanceof DropSpecError || cause instanceof SinkError ? cause.message : String(cause);
      this.error(message, { exit: 1 });
    }
    if (sinks.length === 0 && !(flags["run-hook"] && hook)) this.error("Nothing to test: pass --store … and/or --run-hook with a hook.", { exit: 1 });

    let failed = 0;
    const report = async (stage: string, result: SinkResult | { ok: boolean; detail: string; sink?: string; field?: string }) => {
      if (!result.ok) failed += 1;
      if (flags.json) this.log(JSON.stringify({ event: "hook_test", stage, ...result }));
      else this.log(`${result.ok ? "ok  " : "FAIL"} ${stage.padEnd(9)} ${result.detail}`);
    };

    for (const result of await Promise.all(sinks.map(preflightSink))) await report("preflight", result);

    const dir = mkdtempSync(join(tmpdir(), "peardrop-hook-test-"));
    try {
      const fake = () => fields.map((field) => {
        const path = join(dir, `${field}.txt`);
        writeFileSync(path, `peardrop-hook-test-${randomBytes(6).toString("hex")}\n`, { mode: 0o600 });
        return { name: `${field}.txt`, path };
      });
      const suffix = "-peardrop-test";
      const stored = await runSinks({ sinks: sinks.filter((s) => s.kind !== "file"), files: fake(), suffix, ledgerPath: join(dir, "ledger.jsonl") });
      for (const result of stored) await report("store", result);
      for (const result of stored) {
        if (result.sink === "file" || !result.ok) continue;
        const sink = sinks.find((s) => s.kind === result.sink)!;
        await report("cleanup", await removeFromSink(sink, { field: result.field, suffix, id: result.id }));
      }
      if (flags["run-hook"] && hook) {
        const result = await runOnReceiveHook({ command: hook, targetPath: dir, files: fake(), cwd: process.cwd() });
        await report("hook", { ok: result.ok, detail: result.ok ? `on_receive hook exited 0 (${hook})` : `on_receive hook failed: ${result.error ?? `exit ${result.exitCode ?? result.signal}`}` });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (failed > 0) this.error(`${failed} check(s) failed.`, { exit: 1 });
    if (!flags.json) this.log("All storage checks passed.");
  }
}
