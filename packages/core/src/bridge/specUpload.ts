import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as Schema from "effect/Schema";
import { basename } from "node:path";
import { LimitsError } from "../effect/errors.js";
import { type DropSpec, type FieldSubmission, validateSpecSubmission } from "../spec/dropSpec.js";
import { readBoundedBody } from "./uploadParser.js";

const MAX_BODY_BYTES_DEFAULT = 512 * 1024 * 1024;

const SpecUploadFileSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  bytes: Schema.Int,
  sha256: Schema.NonEmptyString,
  data: Schema.Array(Schema.Int),
});

const SpecUploadValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("file"), files: Schema.Array(SpecUploadFileSchema) }),
]);

const SpecUploadSchema = Schema.Struct({
  values: Schema.Record(Schema.String, SpecUploadValueSchema),
});

export interface DeliverableFile {
  readonly filename: string;
  readonly data: Buffer;
  readonly sha256: string;
}

export type SpecUploadResult =
  | { readonly ok: true; readonly files: ReadonlyArray<DeliverableFile> }
  | { readonly ok: false; readonly errors: Record<string, string> };

const flattenedFilename = (fieldName: string, originalName: string, index: number, total: number): string => {
  const clean = basename(originalName);
  return total > 1 ? `${fieldName}-${index}-${clean}` : `${fieldName}-${clean}`;
};

/** Parses and validates a `{ values: { [field]: ... } }` POST body against a DropSpec. */
export async function parseSpecUpload(req: IncomingMessage, spec: DropSpec, maxSizeMB?: number): Promise<SpecUploadResult> {
  const maxBytes = maxSizeMB ? maxSizeMB * 1024 * 1024 : MAX_BODY_BYTES_DEFAULT;
  const body = await readBoundedBody(req, maxBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8")) as unknown;
  } catch (cause) {
    return { ok: false, errors: { _body: `Malformed upload JSON: ${cause instanceof Error ? cause.message : String(cause)}` } };
  }

  let payload: typeof SpecUploadSchema.Type;
  try {
    payload = Schema.decodeUnknownSync(SpecUploadSchema)(parsed);
  } catch (cause) {
    return { ok: false, errors: { _body: `Malformed upload payload: ${String(cause)}` } };
  }

  const submissions = new Map<string, FieldSubmission>();
  for (const [name, value] of Object.entries(payload.values)) {
    submissions.set(
      name,
      value.kind === "text" ? { kind: "text", text: value.text } : { kind: "file", files: value.files.map((f) => ({ name: f.name, bytes: f.bytes })) }
    );
  }

  const errors = validateSpecSubmission(spec, submissions);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const files: DeliverableFile[] = [];
  let totalBytes = 0;
  for (const field of spec.fields) {
    const value = payload.values[field.name];
    if (!value) continue;

    if (value.kind === "text") {
      if (value.text.length === 0) continue;
      const data = Buffer.from(value.text, "utf-8");
      totalBytes += data.length;
      files.push({ filename: `${field.name}.txt`, data, sha256: createHash("sha256").update(data).digest("hex") });
      continue;
    }

    for (let i = 0; i < value.files.length; i++) {
      const f = value.files[i]!;
      const data = Buffer.from(f.data);
      if (data.length !== f.bytes) {
        return { ok: false, errors: { [field.name]: `Declared bytes ${f.bytes} does not match actual ${data.length} for ${f.name}` } };
      }
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (sha256 !== f.sha256) {
        return { ok: false, errors: { [field.name]: `SHA-256 mismatch for ${f.name}` } };
      }
      totalBytes += data.length;
      files.push({ filename: flattenedFilename(field.name, f.name, i, value.files.length), data, sha256 });
    }
  }

  if (totalBytes > maxBytes) {
    throw new LimitsError({ message: `Total size ${totalBytes} exceeds limit`, limit: String(maxBytes) });
  }

  return { ok: true, files };
}
