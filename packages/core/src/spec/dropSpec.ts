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

const RawFieldSpecSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  type: FieldTypeSchema,
  label: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  link: Schema.optional(FieldLinkSchema),
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
  fields: Schema.NonEmptyArray(RawFieldSpecSchema),
});

export interface DropSpec {
  readonly title?: string;
  readonly description?: string;
  readonly copy: CopySpec;
  readonly hooks: HooksSpec;
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
 * Validates an already-parsed spec object (TOML table or JSON) into a DropSpec.
 * `receive --spec` ships the parsed spec to the Worker as JSON, so the Worker
 * validates with this rather than a second, drifting validator of its own.
 */
export function decodeDropSpec(raw: unknown): DropSpec {
  let decoded: typeof RawDropSpecSchema.Type;
  try {
    decoded = Schema.decodeUnknownSync(RawDropSpecSchema)(raw);
  } catch (cause) {
    throw new DropSpecError({ message: `Invalid drop spec: ${String(cause)}` });
  }

  const spec: DropSpec = {
    title: decoded.title,
    description: decoded.description,
    copy: decoded.copy ?? {},
    hooks: decoded.hooks ?? {},
    fields: decoded.fields.map(withFieldDefaults),
  };

  if (spec.hooks.on_receive !== undefined && spec.hooks.on_receive.trim().length === 0) {
    throw new DropSpecError({ message: "hooks.on_receive must be a non-empty command." });
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
    if (field.link && !field.link.url.startsWith("https://")) {
      throw new DropSpecError({ message: `Field "${field.name}" link.url must be https:// — got "${field.link.url}"` });
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
 */
export function outstandingSpecFields(spec: DropSpec, values: ReadonlyMap<string, FieldSubmission>): ReadonlyArray<string> {
  return spec.fields
    .filter((field) => {
      const submission = values.get(field.name);
      if (!submission) return true;
      return submission.kind === "text" ? submission.text.length === 0 : submission.files.length === 0;
    })
    .map((field) => field.name);
}

export { isMasked };
