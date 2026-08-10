/** TOML-defined drop page specs: field types, quantity, validation, and copy overrides. */
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import { parse as parseToml } from "smol-toml";

export class DropSpecError extends Data.TaggedError("DropSpecError")<{
  readonly message: string;
}> {}

export const FieldTypeSchema = Schema.Literals(["secret", "text", "file", "token"]);
export type FieldType = typeof FieldTypeSchema.Type;

/** Where a receiver goes to find/generate this field's value — https-only, checked at decode time. */
export const FieldLinkSchema = Schema.Struct({
  label: Schema.optional(Schema.String),
  url: Schema.NonEmptyString,
});
export type FieldLink = typeof FieldLinkSchema.Type;

/**
 * Related fields that come from one console/service, rendered as one visual
 * block instead of an undifferentiated flat list (peardrop#34). `link`, like
 * a field's own, is https-only. `allOrNothing` is UI-copy scope only — see
 * the outstanding-fields handling below — never a hard submission block,
 * since specs lean on partial, come-back-later delivery.
 */
export const GroupSpecSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  link: Schema.optional(FieldLinkSchema),
  allOrNothing: Schema.optional(Schema.Boolean),
});
export type GroupSpec = typeof GroupSpecSchema.Type;

const RawFieldSpecSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  type: FieldTypeSchema,
  label: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  link: Schema.optional(FieldLinkSchema),
  group: Schema.optional(Schema.NonEmptyString),
  // A normal field collects a value FROM the recipient. scope/entry_url/
  // resource_name are the opposite direction — things the recipient reads or
  // carries TO the provider, not an input (peardrop#34 addendum). scope is a
  // list so it renders as chips/a checklist, not a paragraph; entry_url is
  // https-only like FieldLinkSchema.url, for the same reason.
  scope: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  entry_url: Schema.optional(Schema.NonEmptyString),
  resource_name: Schema.optional(Schema.NonEmptyString),
  shown_once: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
  masked: Schema.optional(Schema.Boolean),
  placeholder: Schema.optional(Schema.String),
  minLength: Schema.optional(Schema.Int),
  maxLength: Schema.optional(Schema.Int),
  format: Schema.optional(Schema.String),
  count: Schema.optional(Schema.Int),
  message: Schema.optional(Schema.String),
});
type RawFieldSpec = typeof RawFieldSpecSchema.Type;

export interface FieldSpec extends Omit<RawFieldSpec, "required"> {
  readonly required: boolean;
}

export const CopySpecSchema = Schema.Struct({
  request: Schema.optional(Schema.String),
  success: Schema.optional(Schema.String),
  failure: Schema.optional(Schema.String),
});
export type CopySpec = typeof CopySpecSchema.Type;

/** Side effects run after a drop is confirmed written — never part of the delivery transaction. */
export const HooksSpecSchema = Schema.Struct({
  on_receive: Schema.optional(Schema.String),
});
export type HooksSpec = typeof HooksSpecSchema.Type;

const RawDropSpecSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  copy: Schema.optional(CopySpecSchema),
  hooks: Schema.optional(HooksSpecSchema),
  groups: Schema.optional(Schema.Array(GroupSpecSchema)),
  fields: Schema.NonEmptyArray(RawFieldSpecSchema),
});

export interface DropSpec {
  readonly title?: string;
  readonly description?: string;
  readonly copy: CopySpec;
  readonly hooks: HooksSpec;
  readonly groups: ReadonlyArray<GroupSpec>;
  readonly fields: ReadonlyArray<FieldSpec>;
}

/** required defaults to true when the field omits it; every other default lives in validateFieldValue. */
const withFieldDefaults = (field: RawFieldSpec): FieldSpec => ({ ...field, required: field.required ?? true });

export const DEFAULT_VALIDATION_MESSAGES = {
  required: "This field is required.",
  minLength: (min: number) => `Must be at least ${min} character${min === 1 ? "" : "s"}.`,
  maxLength: (max: number) => `Must be at most ${max} character${max === 1 ? "" : "s"}.`,
  format: "This value doesn't match the expected format.",
  count: (count: number) => `Expected exactly ${count} file${count === 1 ? "" : "s"}.`,
};

const isMasked = (field: FieldSpec): boolean => field.masked ?? (field.type === "secret" || field.type === "token");

/**
 * Shared https-only check for every link-shaped value in a spec — field.link,
 * group.link, entry_url alike. Actually parses the URL rather than checking
 * the string prefix (the original field.link check this was extracted from):
 * a well-formed-looking prefix like "https:// evil.com" or "https://" alone
 * isn't a URL a fetch/browser navigation could use, and `new URL` rejects it
 * outright rather than letting a malformed value through under a scheme that
 * merely starts with the right eight characters.
 */
const assertHttpsUrl = (url: string, context: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DropSpecError({ message: `${context} must be a valid https:// URL — got "${url}"` });
  }
  if (parsed.protocol !== "https:") {
    throw new DropSpecError({ message: `${context} must be https:// — got "${url}"` });
  }
};

/**
 * Validates an already-parsed spec object (TOML table or JSON) into a DropSpec.
 * `receive --spec` ships the parsed spec to the Worker as JSON, so the Worker
 * validates with this rather than a second, drifting validator of its own.
 */
export function decodeDropSpec(raw: unknown): DropSpec {
  let decoded: typeof RawDropSpecSchema.Type;
  try {
    // Effect Schema silently drops a key it doesn't recognize by default,
    // at every nesting level — an older core reading a spec with a field it
    // predates (e.g. `link`) would lose that data with zero indication
    // anything was wrong. Confirmed the exact real-world failure this
    // caused (peardrop#36) before erroring on it here instead.
    decoded = Schema.decodeUnknownSync(RawDropSpecSchema, { onExcessProperty: "error" })(raw);
  } catch (cause) {
    throw new DropSpecError({ message: `Invalid drop spec: ${String(cause)}` });
  }

  const spec: DropSpec = {
    title: decoded.title,
    description: decoded.description,
    copy: decoded.copy ?? {},
    hooks: decoded.hooks ?? {},
    groups: decoded.groups ?? [],
    fields: decoded.fields.map(withFieldDefaults),
  };

  if (spec.hooks.on_receive !== undefined && spec.hooks.on_receive.trim().length === 0) {
    throw new DropSpecError({ message: "hooks.on_receive must be a non-empty command." });
  }

  const seenGroups = new Set<string>();
  for (const group of spec.groups) {
    if (seenGroups.has(group.name)) {
      throw new DropSpecError({ message: `Duplicate group name in spec: ${group.name}` });
    }
    seenGroups.add(group.name);
    if (group.link) assertHttpsUrl(group.link.url, `Group "${group.name}" link.url`);
  }

  const seen = new Set<string>();
  for (const field of spec.fields) {
    if (seen.has(field.name)) {
      throw new DropSpecError({ message: `Duplicate field name in spec: ${field.name}` });
    }
    seen.add(field.name);
    if (field.format) {
      try {
        new RegExp(field.format);
      } catch (cause) {
        throw new DropSpecError({ message: `Invalid regex for field "${field.name}": ${cause instanceof Error ? cause.message : String(cause)}` });
      }
    }
    if (field.link) assertHttpsUrl(field.link.url, `Field "${field.name}" link.url`);
    if (field.entry_url) assertHttpsUrl(field.entry_url, `Field "${field.name}" entry_url`);
    if (field.group !== undefined && !seenGroups.has(field.group)) {
      throw new DropSpecError({ message: `Field "${field.name}" references unknown group "${field.group}"` });
    }
  }

  return spec;
}

/** Parses TOML text into a DropSpec, failing clearly (no server started) on malformed input. */
export function parseDropSpecToml(tomlText: string): DropSpec {
  let raw: unknown;
  try {
    raw = parseToml(tomlText);
  } catch (cause) {
    throw new DropSpecError({ message: `Malformed TOML: ${cause instanceof Error ? cause.message : String(cause)}` });
  }
  return decodeDropSpec(raw);
}

/** True when the spec can produce more than one delivered file, which requires a directory target. */
export function specNeedsDirectoryTarget(spec: DropSpec): boolean {
  if (spec.fields.length > 1) return true;
  const [only] = spec.fields;
  return only?.type === "file" && (only.count ?? 1) > 1;
}

/** One rendering unit: either a named group with its member fields, or a single ungrouped field. */
export interface SpecSection {
  readonly group?: GroupSpec;
  readonly fields: ReadonlyArray<FieldSpec>;
}

/**
 * Partitions `spec.fields` into sections in field-declaration order — the
 * TOML's field order is still the single layout source of truth, a group's
 * position is wherever its first member field appears. Only CONSECUTIVE
 * fields sharing the same named `group` merge into one section; two
 * adjacent ungrouped fields each stay their own singleton section.
 *
 * Both renderers (BridgeServer.ts, peardrop.fyi's SPA) must call this
 * rather than re-deriving grouping independently — two renderers drifting
 * apart on the same spec is exactly what caused tonight's link-rendering
 * confusion (peardrop.fyi#104 vs smashah/peardrop#32).
 */
export function groupSpecFields(spec: DropSpec): ReadonlyArray<SpecSection> {
  const groupsByName = new Map(spec.groups.map((group) => [group.name, group] as const));
  const sections: SpecSection[] = [];

  for (const field of spec.fields) {
    const last = sections[sections.length - 1];
    if (field.group !== undefined && last?.group?.name === field.group) {
      sections[sections.length - 1] = { group: last.group, fields: [...last.fields, field] };
    } else {
      sections.push({ group: field.group !== undefined ? groupsByName.get(field.group) : undefined, fields: [field] });
    }
  }

  return sections;
}

export type FieldSubmission = { readonly kind: "text"; readonly text: string } | { readonly kind: "file"; readonly files: ReadonlyArray<{ name: string; bytes: number }> };

/** Validates one submitted field value against its spec, returning the (overridable) error message or null. */
export function validateFieldValue(field: FieldSpec, submission: FieldSubmission | undefined): string | null {
  const override = field.message;

  if (field.type === "file") {
    const files = submission?.kind === "file" ? submission.files : [];
    const expectedCount = field.count ?? 1;
    if (field.required && files.length === 0) return override ?? DEFAULT_VALIDATION_MESSAGES.required;
    if (files.length > 0 && files.length !== expectedCount) return override ?? DEFAULT_VALIDATION_MESSAGES.count(expectedCount);
    return null;
  }

  const text = submission?.kind === "text" ? submission.text : "";
  if (field.required && text.trim().length === 0) return override ?? DEFAULT_VALIDATION_MESSAGES.required;
  if (text.length === 0) return null;
  if (field.minLength !== undefined && text.length < field.minLength) return override ?? DEFAULT_VALIDATION_MESSAGES.minLength(field.minLength);
  if (field.maxLength !== undefined && text.length > field.maxLength) return override ?? DEFAULT_VALIDATION_MESSAGES.maxLength(field.maxLength);
  if (field.format !== undefined && !new RegExp(field.format).test(text)) return override ?? DEFAULT_VALIDATION_MESSAGES.format;
  return null;
}

export function validateSpecSubmission(spec: DropSpec, values: ReadonlyMap<string, FieldSubmission>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of spec.fields) {
    const error = validateFieldValue(field, values.get(field.name));
    if (error) errors[field.name] = error;
  }
  return errors;
}

/**
 * Field names from `spec.fields` that a submission left out — i.e. an
 * optional field with no value or empty text/no files. A submission that
 * validates (`validateSpecSubmission` returns no errors) can still be
 * partial, and this is what tells a receiver which fields to expect later.
 *
 * An `allOrNothing` group that's only partially filled reports every member
 * as outstanding, not just the empty ones — a client ID without its API key
 * is useless, so a partial group is a false partial success, not a real one.
 */
export function outstandingSpecFields(spec: DropSpec, values: ReadonlyMap<string, FieldSubmission>): ReadonlyArray<string> {
  const isEmpty = (field: FieldSpec): boolean => {
    const submission = values.get(field.name);
    if (!submission) return true;
    return submission.kind === "text" ? submission.text.length === 0 : submission.files.length === 0;
  };

  const outstanding = new Set(spec.fields.filter(isEmpty).map((field) => field.name));

  for (const group of spec.groups) {
    if (!group.allOrNothing) continue;
    const members = spec.fields.filter((field) => field.group === group.name);
    const anyFilled = members.some((field) => !isEmpty(field));
    const allFilled = members.every((field) => !isEmpty(field));
    if (anyFilled && !allFilled) {
      for (const field of members) outstanding.add(field.name);
    }
  }

  return spec.fields.map((field) => field.name).filter((name) => outstanding.has(name));
}

export { isMasked };
