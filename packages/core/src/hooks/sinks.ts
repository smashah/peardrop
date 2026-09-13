/**
 * Built-in storage sinks: deliver a received value straight into a Keychain,
 * vault, or env file, then remove the plaintext delivery file. Every sink
 * reports its own result; nothing here ever prints a value.
 */
import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";

export const SINK_KINDS = ["keychain", "passbolt", "1password", "env-file", "file"] as const;
export type SinkKind = (typeof SINK_KINDS)[number];

export interface SinkSpec {
  readonly kind: SinkKind;
  readonly options: Readonly<Record<string, string>>;
  /** The text the operator wrote, for messages. */
  readonly source: string;
}

export interface SinkResult {
  readonly sink: SinkKind;
  readonly field: string;
  readonly ok: boolean;
  /** Human-readable, value-free description of what happened. */
  readonly detail: string;
  /** Provider-side identifier when one exists (Passbolt resource id, 1Password item id). */
  readonly id?: string;
}

export class SinkError extends Error {
  override readonly name = "SinkError";
}

const REQUIRED: Partial<Record<SinkKind, ReadonlyArray<string>>> = { "1password": ["vault"], "env-file": ["path"] };
const KNOWN: Record<SinkKind, ReadonlyArray<string>> = {
  keychain: ["service", "account"],
  passbolt: ["name", "folder", "uri", "username", "bin"],
  "1password": ["vault", "item", "field", "bin"],
  "env-file": ["path", "key"],
  file: [],
};

/** Parses `kind` or `kind:key=value,key=value`, e.g. `keychain:service=starling.pat,account=me`. */
export function parseSinkSpec(text: string): SinkSpec {
  const colon = text.indexOf(":");
  const kind = (colon === -1 ? text : text.slice(0, colon)).trim() as SinkKind;
  if (!SINK_KINDS.includes(kind)) throw new SinkError(`Unknown sink "${kind}" in "${text}"; use one of ${SINK_KINDS.join(", ")}.`);
  const options: Record<string, string> = {};
  const rest = colon === -1 ? "" : text.slice(colon + 1);
  for (const pair of rest.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new SinkError(`Sink option "${pair}" in "${text}" must be key=value.`);
    const key = pair.slice(0, eq).trim();
    if (!KNOWN[kind].includes(key)) throw new SinkError(`Sink "${kind}" does not take "${key}"; known options: ${KNOWN[kind].join(", ") || "none"}.`);
    options[key] = pair.slice(eq + 1).trim();
  }
  for (const key of REQUIRED[kind] ?? []) {
    if (!options[key]) throw new SinkError(`Sink "${kind}" needs ${key}=… (in "${text}").`);
  }
  return { kind, options, source: text };
}

/** True when the operator asked to keep the plaintext delivery file. */
export const sinksKeepPlaintext = (sinks: ReadonlyArray<SinkSpec>): boolean => sinks.some((s) => s.kind === "file");

interface Exec { code: number | null; stdout: string; stderr: string }

function exec(command: string, args: ReadonlyArray<string>, input?: string): Promise<Exec> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: process.env });
    } catch (cause) {
      resolve({ code: null, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.once("error", (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

const name = (template: string | undefined, fallback: string, field: string, suffix: string): string =>
  `${(template ?? fallback).replaceAll("{field}", field)}${suffix}`;

const jsonId = (text: string): string | undefined => {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { id?: unknown; ID?: unknown };
    const id = parsed.id ?? parsed.ID;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
};

/** Names the entry a sink would write for `field`, so callers can say so before anything is stored. */
export function describeSinkTarget(sink: SinkSpec, field: string, suffix = ""): string {
  const o = sink.options;
  switch (sink.kind) {
    case "keychain": return `Keychain service ${name(o.service, "peardrop.{field}", field, suffix)} account ${o.account ?? userInfo().username}`;
    case "passbolt": return `Passbolt resource "${name(o.name, "{field}", field, suffix)}"${o.folder ? ` in folder ${o.folder}` : ""}`;
    case "1password": return `1Password item "${name(o.item, "{field}", field, suffix)}" in vault ${o.vault}`;
    case "env-file": return `${o.path} key ${name(o.key, field.toUpperCase().replace(/[^A-Z0-9]/g, "_"), field, suffix.toUpperCase().replace(/[^A-Z0-9]/g, "_"))}`;
    case "file": return "plaintext delivery file kept";
  }
}

const shellQuote = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Proves the sink is reachable and writable before a URL is ever shared. Writes and removes a probe entry where that is the only honest check. */
export async function preflightSink(sink: SinkSpec): Promise<SinkResult> {
  const field = "preflight";
  const o = sink.options;
  const fail = (detail: string): SinkResult => ({ sink: sink.kind, field, ok: false, detail });
  const ok = (detail: string): SinkResult => ({ sink: sink.kind, field, ok: true, detail });
  switch (sink.kind) {
    case "file":
      return ok("plaintext file will be kept in the target");
    case "keychain": {
      const account = o.account ?? userInfo().username;
      const add = await exec("security", ["-i"], `add-generic-password -U -s "peardrop.preflight" -a ${shellQuote(account)} -w "probe"\n`);
      if (add.code !== 0) return fail(`Keychain write failed: ${add.stderr.trim() || `exit ${add.code}`}`);
      await exec("security", ["delete-generic-password", "-s", "peardrop.preflight", "-a", account]);
      return ok(`Keychain writable for account ${account}`);
    }
    case "passbolt": {
      const bin = o.bin ?? "passbolt";
      const folders = await exec(bin, ["list", "folder", "-j"]);
      if (folders.code !== 0) return fail(`Passbolt CLI not ready: ${folders.stderr.trim().split("\n").at(-1) ?? `exit ${folders.code}`}`);
      if (o.folder && !folders.stdout.includes(`"${o.folder}"`)) return fail(`Passbolt folder ${o.folder} is not visible to this user`);
      const args = ["create", "resource", "-j", "-n", "peardrop preflight (safe to delete)", "-p", "probe", ...(o.folder ? ["-f", o.folder] : [])];
      const create = await exec(bin, args);
      const id = jsonId(create.stdout);
      if (create.code !== 0 || !id) return fail(`Passbolt cannot create${o.folder ? ` in folder ${o.folder}` : ""}: ${create.stderr.trim().split("\n").at(-1) ?? `exit ${create.code}`}`);
      await exec(bin, ["delete", "resource", "--id", id]);
      return ok(`Passbolt writable${o.folder ? ` in folder ${o.folder}` : " at root"}`);
    }
    case "1password": {
      const bin = o.bin ?? "op";
      const vault = await exec(bin, ["vault", "get", o.vault!, "--format", "json"]);
      if (vault.code !== 0) return fail(`1Password vault ${o.vault} not available: ${vault.stderr.trim().split("\n").at(-1) ?? `exit ${vault.code}`}`);
      return ok(`1Password vault ${o.vault} reachable`);
    }
    case "env-file": {
      const path = o.path!;
      try {
        if (existsSync(path)) accessSync(path, constants.W_OK);
        else accessSync(dirname(path), constants.W_OK);
        return ok(`${path} writable`);
      } catch (cause) {
        return fail(`${path} not writable: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
}

export interface StoreInput {
  readonly field: string;
  readonly value: string;
  /** Appended to every entry name; `hook test` uses it to keep test entries apart. */
  readonly suffix?: string;
}

/** Writes one value into one sink. Never throws; never includes the value in the result. */
export async function storeToSink(sink: SinkSpec, input: StoreInput): Promise<SinkResult> {
  const { field, value } = input;
  const suffix = input.suffix ?? "";
  const o = sink.options;
  const target = describeSinkTarget(sink, field, suffix);
  const fail = (detail: string, id?: string): SinkResult => ({ sink: sink.kind, field, ok: false, detail, ...(id ? { id } : {}) });
  const ok = (detail: string, id?: string): SinkResult => ({ sink: sink.kind, field, ok: true, detail, ...(id ? { id } : {}) });
  switch (sink.kind) {
    case "file":
      return ok(target);
    case "keychain": {
      const service = name(o.service, "peardrop.{field}", field, suffix);
      const account = o.account ?? userInfo().username;
      // The value travels to `security -i` on stdin, never on argv.
      const add = await exec("security", ["-i"], `add-generic-password -U -s ${shellQuote(service)} -a ${shellQuote(account)} -w ${shellQuote(value)}\n`);
      if (add.code !== 0) return fail(`${target}: write failed (${add.stderr.trim() || `exit ${add.code}`})`);
      const back = await exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (back.stdout.replace(/\n$/, "") !== value) return fail(`${target}: readback mismatch`);
      return ok(`${target}: stored and verified`);
    }
    case "passbolt": {
      const bin = o.bin ?? "passbolt";
      const args = ["create", "resource", "-j", "-n", name(o.name, "{field}", field, suffix), ...(o.folder ? ["-f", o.folder] : []), ...(o.uri ? ["--uri", o.uri] : []), ...(o.username ? ["-u", o.username] : []), "-p", value];
      // go-passbolt-cli has no stdin option: the value is on this child's argv for the duration of the call.
      const create = await exec(bin, args);
      const id = jsonId(create.stdout);
      if (create.code !== 0 || !id) return fail(`${target}: create failed (${create.stderr.trim().split("\n").at(-1) ?? `exit ${create.code}`})`);
      return ok(`${target}: stored`, id);
    }
    case "1password": {
      const bin = o.bin ?? "op";
      const title = name(o.item, "{field}", field, suffix);
      const dir = mkdtempSync(join(tmpdir(), "peardrop-op-"));
      const template = join(dir, "item.json");
      try {
        // The value reaches op through a 0600 template file, never argv.
        writeFileSync(template, JSON.stringify({
          title,
          category: "API_CREDENTIAL",
          fields: [{ id: o.field ?? "credential", type: "CONCEALED", label: o.field ?? "credential", value }],
        }), { mode: 0o600 });
        const create = await exec(bin, ["item", "create", "--template", template, "--vault", o.vault!, "--title", title, "--format", "json"]);
        const id = jsonId(create.stdout);
        if (create.code !== 0 || !id) return fail(`${target}: create failed (${create.stderr.trim().split("\n").at(-1) ?? `exit ${create.code}`})`);
        return ok(`${target}: stored`, id);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case "env-file": {
      const path = o.path!;
      const key = name(o.key, field.toUpperCase().replace(/[^A-Z0-9]/g, "_"), field, suffix.toUpperCase().replace(/[^A-Z0-9]/g, "_"));
      try {
        const current = existsSync(path) ? readFileSync(path, "utf8") : "";
        const line = `${key}='${value.replace(/'/g, "'\\''")}'`;
        const lines = current.split("\n");
        const index = lines.findIndex((l) => l.startsWith(`${key}=`));
        if (index === -1) {
          const body = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
          writeFileSync(path, `${body}${line}\n`, { mode: 0o600 });
        } else {
          lines[index] = line;
          writeFileSync(path, lines.join("\n"), { mode: 0o600 });
        }
        return ok(`${target}: written`);
      } catch (cause) {
        return fail(`${target}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
}

/** Removes what `storeToSink` wrote (used by `hook test` cleanup). */
export async function removeFromSink(sink: SinkSpec, input: { field: string; suffix?: string; id?: string }): Promise<SinkResult> {
  const { field } = input;
  const suffix = input.suffix ?? "";
  const o = sink.options;
  const target = describeSinkTarget(sink, field, suffix);
  const done = (ok: boolean, detail: string): SinkResult => ({ sink: sink.kind, field, ok, detail });
  switch (sink.kind) {
    case "file": return done(true, "nothing to remove");
    case "keychain": {
      const r = await exec("security", ["delete-generic-password", "-s", name(o.service, "peardrop.{field}", field, suffix), "-a", o.account ?? userInfo().username]);
      return done(r.code === 0, `${target}: ${r.code === 0 ? "removed" : "remove failed"}`);
    }
    case "passbolt": {
      if (!input.id) return done(false, `${target}: no id to remove`);
      const r = await exec(o.bin ?? "passbolt", ["delete", "resource", "--id", input.id]);
      return done(r.code === 0, `${target}: ${r.code === 0 ? "removed" : "remove failed"}`);
    }
    case "1password": {
      if (!input.id) return done(false, `${target}: no id to remove`);
      const r = await exec(o.bin ?? "op", ["item", "delete", input.id, "--vault", o.vault!]);
      return done(r.code === 0, `${target}: ${r.code === 0 ? "removed" : "remove failed"}`);
    }
    case "env-file": {
      const path = o.path!;
      const key = name(o.key, field.toUpperCase().replace(/[^A-Z0-9]/g, "_"), field, suffix.toUpperCase().replace(/[^A-Z0-9]/g, "_"));
      if (!existsSync(path)) return done(true, `${target}: file absent`);
      const kept = readFileSync(path, "utf8").split("\n").filter((l) => !l.startsWith(`${key}=`));
      writeFileSync(path, kept.join("\n"), { mode: 0o600 });
      return done(true, `${target}: removed`);
    }
  }
}

export interface DeliveredForSinks {
  readonly name: string;
  readonly path?: string;
}

export interface RunSinksOptions {
  readonly sinks: ReadonlyArray<SinkSpec>;
  readonly files: ReadonlyArray<DeliveredForSinks>;
  readonly suffix?: string;
  /** Written to the metadata ledger with every result; never a value. */
  readonly tunnelId?: string;
  readonly ledgerPath?: string;
}

/** Field name for a delivered file: `<name>.txt` -> `name`. */
export const fieldOfFile = (fileName: string): string => basename(fileName, extname(fileName));

/**
 * Stores every delivered file into every sink, then (unless a `file` sink keeps
 * it) overwrites and removes the plaintext. Appends value-free ledger rows.
 */
export async function runSinks(options: RunSinksOptions): Promise<SinkResult[]> {
  const results: SinkResult[] = [];
  const keep = sinksKeepPlaintext(options.sinks);
  const ledger = options.ledgerPath ?? join(homedir(), ".peardrop", "ledger.jsonl");
  for (const file of options.files) {
    if (!file.path || !existsSync(file.path)) continue;
    const field = fieldOfFile(file.name);
    const value = readFileSync(file.path, "utf8").replace(/\r?\n$/, "");
    const bytes = statSync(file.path).size;
    const sha256 = createHash("sha256").update(value).digest("hex").slice(0, 12);
    let allStored = true;
    for (const sink of options.sinks) {
      if (sink.kind === "file") continue;
      const result = await storeToSink(sink, { field, value, suffix: options.suffix });
      if (!result.ok) allStored = false;
      results.push(result);
      try {
        mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
        appendFileSync(ledger, `${JSON.stringify({ ts: new Date().toISOString(), tunnelId: options.tunnelId, field, bytes, sha256_prefix: sha256, sink: sink.kind, ok: result.ok, id: result.id, detail: result.detail })}\n`, { mode: 0o600 });
      } catch {
        // the ledger is bookkeeping; never fail a store over it
      }
    }
    if (!keep && !allStored) {
      // Never destroy the only copy of a just-pasted secret: a failed store keeps the 0600 file for a retry.
      results.push({ sink: "file", field, ok: false, detail: `plaintext ${file.path} kept because a sink failed; store it by hand, then delete it` });
    } else if (!keep) {
      try {
        writeFileSync(file.path, "\0".repeat(bytes));
        rmSync(file.path, { force: true });
        results.push({ sink: "file", field, ok: true, detail: `plaintext ${file.path} removed` });
      } catch (cause) {
        results.push({ sink: "file", field, ok: false, detail: `plaintext ${file.path} could not be removed: ${cause instanceof Error ? cause.message : String(cause)}` });
      }
    }
  }
  return results;
}
