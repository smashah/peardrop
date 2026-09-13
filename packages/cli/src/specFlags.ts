import { Flags } from "@oclif/core";
import { readFileSync } from "node:fs";
import { DropSpecError, decodeDropSpec, parseDropSpecToml, stringifyDropSpecToml, type DropSpec } from "@peardrop/core";

/**
 * Inline drop-page authoring: everything a routine drop needs as flags, so a
 * one-token page needs no TOML file. TOML stays the format for reusable or
 * elaborate specs (groups, many fields); `--print-spec` turns a good inline
 * drop into one.
 */
export const specFlags = {
  spec: Flags.string({ description: "Path to a TOML drop-page spec file", exclusive: ["spec-inline"] }),
  "spec-inline": Flags.string({ description: "Inline TOML drop-page spec", exclusive: ["spec"] }),
  title: Flags.string({ description: "Page title (inline spec)" }),
  description: Flags.string({ description: "Page description, markdown (inline spec)" }),
  request: Flags.string({ description: "Instructions shown above the fields, markdown (inline spec)" }),
  success: Flags.string({ description: "Message shown after a successful drop (inline spec)" }),
  failure: Flags.string({ description: "Message shown when a drop is rejected (inline spec)" }),
  field: Flags.string({ multiple: true, description: "Field as name:type[:label]; type is text, secret, token, or file. Repeat for more fields (inline spec)" }),
  "field-description": Flags.string({ multiple: true, description: "name=markdown shown under the field" }),
  "field-link": Flags.string({ multiple: true, description: "name=https://url or name=Label|https://url; the field's action button" }),
  "field-scope": Flags.string({ multiple: true, description: "name=scope1,scope2; provider permissions to request" }),
  "field-resource-name": Flags.string({ multiple: true, description: "name=suggested provider-side name" }),
  "field-entry-url": Flags.string({ multiple: true, description: "name=https://url the sender carries into the provider (read-only)" }),
  "field-placeholder": Flags.string({ multiple: true, description: "name=placeholder text" }),
  "field-format": Flags.string({ multiple: true, description: "name=regex the value must match" }),
  "field-min-length": Flags.string({ multiple: true, description: "name=N" }),
  "field-max-length": Flags.string({ multiple: true, description: "name=N" }),
  "field-count": Flags.string({ multiple: true, description: "name=N exact file count (file fields)" }),
  "field-message": Flags.string({ multiple: true, description: "name=text replacing the validation error message" }),
  "field-optional": Flags.string({ multiple: true, description: "name; the field may be left blank" }),
  "field-shown-once": Flags.string({ multiple: true, description: "name; the provider shows the value only once" }),
  "field-unmasked": Flags.string({ multiple: true, description: "name; show a secret/token while typing" }),
  "print-spec": Flags.boolean({ description: "Print the drop spec as TOML and exit without starting a receiver" }),
};

type SpecFlagValues = {
  spec?: string;
  "spec-inline"?: string;
  title?: string;
  description?: string;
  request?: string;
  success?: string;
  failure?: string;
  field?: string[];
  "field-description"?: string[];
  "field-link"?: string[];
  "field-scope"?: string[];
  "field-resource-name"?: string[];
  "field-entry-url"?: string[];
  "field-placeholder"?: string[];
  "field-format"?: string[];
  "field-min-length"?: string[];
  "field-max-length"?: string[];
  "field-count"?: string[];
  "field-message"?: string[];
  "field-optional"?: string[];
  "field-shown-once"?: string[];
  "field-unmasked"?: string[];
  "on-receive"?: string;
};

const FIELD_TYPES = new Set(["text", "secret", "token", "file"]);
const INLINE_KEYS = ["title", "description", "request", "success", "failure", "field"] as const;
const PER_FIELD_KEYS = [
  "field-description", "field-link", "field-scope", "field-resource-name", "field-entry-url", "field-placeholder",
  "field-format", "field-min-length", "field-max-length", "field-count", "field-message", "field-optional",
  "field-shown-once", "field-unmasked",
] as const;

const fail = (message: string): never => {
  throw new DropSpecError({ message });
};

/** Splits `name=value`; a bare `name` yields an empty value. */
const nameValue = (flag: string, entry: string): [string, string] => {
  const index = entry.indexOf("=");
  const name = (index === -1 ? entry : entry.slice(0, index)).trim();
  if (!name) return fail(`--${flag} needs a field name, got "${entry}".`);
  return [name, index === -1 ? "" : entry.slice(index + 1)];
};

const integer = (flag: string, value: string): number => {
  if (!/^\d+$/.test(value)) return fail(`--${flag} needs a whole number, got "${value}".`);
  return Number(value);
};

/** Builds the raw spec object (the shape TOML parses to) from inline flags. */
export function rawSpecFromFlags(flags: SpecFlagValues): Record<string, unknown> | undefined {
  const usesInline = INLINE_KEYS.some((key) => flags[key] !== undefined) || PER_FIELD_KEYS.some((key) => flags[key] !== undefined);
  if (!usesInline) return undefined;
  if (flags.spec !== undefined || flags["spec-inline"] !== undefined) {
    return fail("Use either --spec/--spec-inline or the inline --title/--field flags, not both.");
  }
  if (!flags.field?.length) return fail("Inline specs need at least one --field name:type[:label].");

  const fields: Record<string, Record<string, unknown>> = {};
  const ordered: Record<string, unknown>[] = [];
  for (const entry of flags.field) {
    const [name, type, ...labelParts] = entry.split(":");
    if (!name?.trim() || !type?.trim()) return fail(`--field needs name:type[:label], got "${entry}".`);
    if (!FIELD_TYPES.has(type.trim())) return fail(`--field "${name}": type must be text, secret, token, or file, got "${type}".`);
    if (fields[name.trim()]) return fail(`Duplicate --field name "${name.trim()}".`);
    const field: Record<string, unknown> = { name: name.trim(), type: type.trim() };
    const label = labelParts.join(":").trim();
    if (label) field.label = label;
    fields[name.trim()] = field;
    ordered.push(field);
  }

  const target = (flag: string, entry: string): [Record<string, unknown>, string] => {
    const [name, value] = nameValue(flag, entry);
    const field = fields[name];
    if (!field) return fail(`--${flag} names unknown field "${name}"; declare it with --field first.`);
    return [field, value];
  };

  for (const entry of flags["field-description"] ?? []) { const [f, v] = target("field-description", entry); f.description = v; }
  for (const entry of flags["field-link"] ?? []) {
    const [f, v] = target("field-link", entry);
    const bar = v.lastIndexOf("|");
    f.link = bar === -1 ? { url: v.trim() } : { label: v.slice(0, bar).trim(), url: v.slice(bar + 1).trim() };
  }
  for (const entry of flags["field-scope"] ?? []) {
    const [f, v] = target("field-scope", entry);
    f.scope = v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  for (const entry of flags["field-resource-name"] ?? []) { const [f, v] = target("field-resource-name", entry); f.resource_name = v.trim(); }
  for (const entry of flags["field-entry-url"] ?? []) { const [f, v] = target("field-entry-url", entry); f.entry_url = v.trim(); }
  for (const entry of flags["field-placeholder"] ?? []) { const [f, v] = target("field-placeholder", entry); f.placeholder = v; }
  for (const entry of flags["field-format"] ?? []) { const [f, v] = target("field-format", entry); f.format = v; }
  for (const entry of flags["field-min-length"] ?? []) { const [f, v] = target("field-min-length", entry); f.minLength = integer("field-min-length", v); }
  for (const entry of flags["field-max-length"] ?? []) { const [f, v] = target("field-max-length", entry); f.maxLength = integer("field-max-length", v); }
  for (const entry of flags["field-count"] ?? []) { const [f, v] = target("field-count", entry); f.count = integer("field-count", v); }
  for (const entry of flags["field-message"] ?? []) { const [f, v] = target("field-message", entry); f.message = v; }
  for (const entry of flags["field-optional"] ?? []) { const [f] = target("field-optional", entry); f.required = false; }
  for (const entry of flags["field-shown-once"] ?? []) { const [f] = target("field-shown-once", entry); f.shown_once = true; }
  for (const entry of flags["field-unmasked"] ?? []) { const [f] = target("field-unmasked", entry); f.masked = false; }

  const raw: Record<string, unknown> = {};
  if (flags.title !== undefined) raw.title = flags.title;
  if (flags.description !== undefined) raw.description = flags.description;
  const copy: Record<string, string> = {};
  if (flags.request !== undefined) copy.request = flags.request;
  if (flags.success !== undefined) copy.success = flags.success;
  if (flags.failure !== undefined) copy.failure = flags.failure;
  if (Object.keys(copy).length > 0) raw.copy = copy;
  if (flags["on-receive"] !== undefined && flags["on-receive"].trim()) raw.hooks = { on_receive: flags["on-receive"] };
  raw.fields = ordered;
  return raw;
}

export interface LoadedSpec {
  readonly spec: DropSpec;
  /** TOML text equivalent to `spec`, for --print-spec. */
  readonly toml: string;
}

/** Resolves --spec, --spec-inline, or the inline flags into one validated spec. Throws DropSpecError. */
export function loadSpecFromFlags(flags: SpecFlagValues): LoadedSpec | undefined {
  const raw = rawSpecFromFlags(flags);
  if (raw !== undefined) return { spec: decodeDropSpec(raw), toml: stringifyDropSpecToml(raw) };
  const source = flags["spec-inline"] ?? (flags.spec !== undefined ? readFileSync(flags.spec, "utf-8") : undefined);
  if (source === undefined) return undefined;
  return { spec: parseDropSpecToml(source), toml: source.endsWith("\n") ? source : `${source}\n` };
}
