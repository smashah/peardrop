import { Command, Flags } from "@oclif/core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSinkSpec, preflightSink, SinkError, walletPath } from "@peardrop/core/node";
import { installationDiagnostics } from "../diagnostics/installation.js";
import { isProcessAlive } from "../detachLog.js";
import { staleSkillInstalls } from "./agent.js";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** One place for everything that used to be guesswork: installs, runtime, Worker, wallet, receivers, skills, sinks. */
export default class DoctorCommand extends Command {
  static override description = "Check this machine's PearDrop setup: installations on PATH, Node, Worker reachability, wallet, running receivers, installed skills, and optional --store sinks";

  static override flags = {
    json: Flags.boolean({ description: "Print checks as JSON" }),
    store: Flags.string({ multiple: true, description: "Sink to preflight, e.g. keychain:service=x or passbolt:folder=<id>" }),
    "worker-url": Flags.string({ description: "Worker API URL", default: "https://peardrop.fyi" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DoctorCommand);
    const checks: Check[] = [];

    const installs = await installationDiagnostics(process.argv[1] ?? "peardrop");
    const others = installs.split("\n").filter((line) => line.startsWith("Other PATH installation") || line.startsWith("Bare peardrop on PATH"));
    const resolved = /Resolved executable: "([^"]+)" \(version "([^"]+)"\)/.exec(installs);
    const multiple = installs.includes("Multiple installations found");
    checks.push({
      name: "installation",
      ok: !multiple,
      detail: multiple
        ? `several PearDrop installations on PATH — keep using npx --yes @peardrop/cli@latest and remove the others: ${others.join("; ")}`
        : `running ${resolved?.[2] ?? "unknown"} from ${resolved?.[1] ?? process.argv[1]}`,
    });

    const major = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "node", ok: major >= 20, detail: `Node ${process.versions.node}${major >= 20 ? "" : " (20 or newer required)"}` });

    const workerUrl = flags["worker-url"].replace(/\/$/, "");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(`${workerUrl}/api/tunnels/peardrop-doctor-probe`, { signal: controller.signal });
      clearTimeout(timer);
      await res.body?.cancel().catch(() => undefined);
      checks.push({ name: "worker", ok: res.status === 404 || res.ok, detail: `${workerUrl} answered HTTP ${res.status}` });
    } catch (cause) {
      checks.push({ name: "worker", ok: false, detail: `${workerUrl} unreachable: ${cause instanceof Error ? cause.message : String(cause)}` });
    }

    const walletConfigured = Boolean(process.env.PEARDROP_WALLET_PRIVATE_KEY) || existsSync(walletPath());
    checks.push({ name: "wallet", ok: true, detail: walletConfigured ? "configured (relay usage above the free tier can be paid)" : "not configured; direct transfers and the free relay tier still work" });

    const tunnels = join(homedir(), ".peardrop", "tunnels");
    let running = 0;
    let waiting = 0;
    if (existsSync(tunnels)) {
      for (const name of readdirSync(tunnels).filter((n) => n.endsWith(".json"))) {
        try {
          const session = JSON.parse(readFileSync(join(tunnels, name), "utf8")) as { status?: string; pid?: number };
          if (session.status === "waiting") waiting += 1;
          if (session.status === "waiting" && isProcessAlive(session.pid)) running += 1;
        } catch {
          // ignore unreadable sessions
        }
      }
      const mode = statSync(tunnels).mode & 0o777;
      checks.push({ name: "sessions", ok: mode === 0o700 || mode === 0o755 || true, detail: `${tunnels}: ${running} receiver${running === 1 ? "" : "s"} running, ${waiting} session${waiting === 1 ? "" : "s"} waiting` });
    } else {
      checks.push({ name: "sessions", ok: true, detail: "no sessions yet" });
    }

    const stale = await staleSkillInstalls();
    checks.push({
      name: "skills",
      ok: stale.length === 0,
      detail: stale.length === 0
        ? "installed skills match this CLI (or none installed; run peardrop agent --install)"
        : `stale skill copies: ${stale.map((s) => `${s.path} (${s.version})`).join(", ")} — run npx --yes @peardrop/cli@latest agent --update`,
    });

    for (const text of flags.store ?? []) {
      try {
        const result = await preflightSink(parseSinkSpec(text));
        checks.push({ name: `sink ${result.sink}`, ok: result.ok, detail: result.detail });
      } catch (cause) {
        checks.push({ name: `sink ${text}`, ok: false, detail: cause instanceof SinkError ? cause.message : String(cause) });
      }
    }

    const failed = checks.filter((c) => !c.ok);
    if (flags.json) {
      this.log(JSON.stringify({ ok: failed.length === 0, checks }));
    } else {
      for (const check of checks) this.log(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(14)} ${check.detail}`);
      this.log(failed.length === 0 ? "Everything looks fine." : `${failed.length} check(s) need attention. Report a problem: https://github.com/smashah/peardrop/issues/new?template=drop-problem.yml`);
    }
    if (failed.length > 0) this.exit(1);
  }
}
