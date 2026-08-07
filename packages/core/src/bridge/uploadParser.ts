import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { chmodSync } from "node:fs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { LimitsError, HashError, FileWriteError } from "../effect/errors.js";

const MAX_BODY_BYTES_DEFAULT = 512 * 1024 * 1024;

export interface ParsedUploadFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly data: Buffer;
}

export interface ParsedUpload {
  readonly kind: "files" | "text";
  readonly files: ParsedUploadFile[];
}

const UploadFileSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  bytes: Schema.Int,
  sha256: Schema.NonEmptyString,
  data: Schema.Array(Schema.Int),
});

const JsonUploadSchema = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["files", "text"])),
  files: Schema.optional(Schema.Array(UploadFileSchema)),
});

const UploadManifestSchema = Schema.Struct({
  kind: Schema.Literals(["files", "text"]),
  files: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      bytes: Schema.Int,
      sha256: Schema.NonEmptyString,
    })
  ),
});

const parseJson = (body: Buffer, label: string): unknown => {
  try {
    return JSON.parse(body.toString("utf-8")) as unknown;
  } catch (cause) {
    throw new LimitsError({ message: `Malformed ${label}: ${String(cause)}`, limit: label });
  }
};

export async function parseMultipartUpload(
  req: IncomingMessage,
  maxSizeMB?: number,
  expectedFiles?: number
): Promise<ParsedUpload> {
  const maxBytes = maxSizeMB ? maxSizeMB * 1024 * 1024 : MAX_BODY_BYTES_DEFAULT;
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    return parseMultipartForm(req, maxBytes, expectedFiles);
  }

  return parseJsonUpload(req, maxBytes, expectedFiles);
}

export async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new LimitsError({
        message: `Request body exceeds ${maxBytes} byte limit`,
        limit: String(maxBytes),
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function parseJsonUpload(
  req: IncomingMessage,
  maxBytes: number,
  expectedFiles?: number
): Promise<ParsedUpload> {
  const body = await readBoundedBody(req, maxBytes);
  const payload = Schema.decodeUnknownSync(JsonUploadSchema)(parseJson(body, "upload JSON"));

  const kind = payload.kind || "files";
  const rawFiles = payload.files || [];

  if (expectedFiles && rawFiles.length > expectedFiles) {
    throw new LimitsError({
      message: `Expected at most ${expectedFiles} file(s), got ${rawFiles.length}`,
      limit: String(expectedFiles),
    });
  }

  const files: ParsedUploadFile[] = [];
  let totalBytes = 0;

  for (const f of rawFiles) {
    const data = Buffer.from(f.data);
    if (data.length !== f.bytes) {
      throw new HashError({
        message: `Declared bytes ${f.bytes} does not match actual ${data.length} for ${f.name}`,
      });
    }
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== f.sha256) {
      throw new HashError({
        message: `SHA-256 mismatch for ${f.name}`,
        expected: f.sha256,
        actual: hash,
      });
    }
    totalBytes += data.length;
    files.push({ name: f.name, bytes: f.bytes, sha256: f.sha256, data });
  }

  if (totalBytes > maxBytes) {
    throw new LimitsError({ message: `Total size ${totalBytes} exceeds limit`, limit: String(maxBytes) });
  }

  return { kind, files };
}

async function parseMultipartForm(
  req: IncomingMessage,
  maxBytes: number,
  expectedFiles?: number
): Promise<ParsedUpload> {
  const body = await readBoundedBody(req, maxBytes);
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) {
    throw new LimitsError({ message: "Missing multipart boundary", limit: "boundary" });
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2]!;

  const parts = splitMultipart(body, boundary);
  const manifestPart = parts.find((p) => p.name === "manifest");
  if (!manifestPart) {
    throw new LimitsError({ message: "Missing manifest part", limit: "manifest" });
  }

  const manifest = Schema.decodeUnknownSync(UploadManifestSchema)(parseJson(manifestPart.data, "upload manifest"));

  if (expectedFiles && manifest.files.length > expectedFiles) {
    throw new LimitsError({
      message: `Expected at most ${expectedFiles} file(s)`,
      limit: String(expectedFiles),
    });
  }

  const files: ParsedUploadFile[] = [];
  let totalBytes = 0;

  for (let i = 0; i < manifest.files.length; i++) {
    const meta = manifest.files[i]!;
    const part = parts.find((p) => p.name === `file${i}`);
    if (!part) {
      throw new LimitsError({ message: `Missing file part file${i}`, limit: "file" });
    }
    if (part.data.length !== meta.bytes) {
      throw new HashError({
        message: `Declared bytes ${meta.bytes} does not match actual ${part.data.length}`,
      });
    }
    const hash = createHash("sha256").update(part.data).digest("hex");
    if (hash !== meta.sha256) {
      throw new HashError({ message: `SHA-256 mismatch for ${meta.name}`, expected: meta.sha256, actual: hash });
    }
    totalBytes += part.data.length;
    files.push({ name: meta.name, bytes: meta.bytes, sha256: meta.sha256, data: part.data });
  }

  if (totalBytes > maxBytes) {
    throw new LimitsError({ message: `Total size exceeds limit`, limit: String(maxBytes) });
  }

  return { kind: manifest.kind, files };
}

interface MultipartPart {
  name: string;
  data: Buffer;
}

function splitMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delim = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let start = body.indexOf(delim) + delim.length;

  while (start > delim.length - 1) {
    const next = body.indexOf(delim, start);
    const end = next === -1 ? body.length : next;
    const slice = body.subarray(start, end);
    const headerEnd = slice.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const headers = slice.subarray(0, headerEnd).toString("utf-8");
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (nameMatch) {
      const data = slice.subarray(headerEnd + 4);
      const trimmed = data.subarray(0, data.length - 2);
      parts.push({ name: nameMatch[1]!, data: trimmed });
    }
    if (next === -1) break;
    start = next + delim.length;
  }

  return parts;
}

export function setSecureFileMode(path: string): void {
  Effect.runSync(Effect.try({
    try: () => chmodSync(path, 0o600),
    catch: (cause) => new FileWriteError({ message: String(cause), path }),
  }).pipe(Effect.ignore));
}
