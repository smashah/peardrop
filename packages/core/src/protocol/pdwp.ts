import * as Schema from "effect/Schema";

export enum FrameType {
  HELLO = 1,
  MANIFEST = 2,
  ACCEPT = 3,
  FILE = 4,
  FILE_END = 5,
  DONE = 6,
  ERR = 7,
}

export const MAX_PDWP_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_PDWP_BUFFER_BYTES = MAX_PDWP_FRAME_BYTES + 5;

export class PdwpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdwpProtocolError";
  }
}

export interface FileManifest {
  name: string;
  bytes: number;
  sha256: string;
  gzip?: boolean;
}

export interface ManifestPayload {
  files: FileManifest[];
  totalBytes: number;
  kind: "files" | "text";
}

export interface HelloPayload {
  v: 1;
  pin?: string;
}

export interface AcceptPayload {
  ok: true;
}

export interface FileEndPayload {
  fileIndex: number;
  sha256: string;
}

export interface DonePayload {
  ok: true;
  files: Array<{
    name: string;
    path?: string;
    bytes: number;
    sha256: string;
  }>;
}

export interface ErrPayload {
  code: "PIN" | "LIMITS" | "HASH" | "TIMEOUT" | "UNKNOWN";
  message?: string;
  fileIndex?: number;
}

export interface ParsedFrame {
  type: FrameType;
  payload: unknown;
  rawBuffer: Buffer;
}

export const FileManifestSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  bytes: Schema.Number,
  sha256: Schema.NonEmptyString,
  gzip: Schema.optional(Schema.Boolean),
});

export const ManifestPayloadSchema = Schema.Struct({
  files: Schema.Array(FileManifestSchema),
  totalBytes: Schema.Number,
  kind: Schema.Literals(["files", "text"]),
});

export const FileEndPayloadSchema = Schema.Struct({
  fileIndex: Schema.Number,
  sha256: Schema.NonEmptyString,
});

export const DonePayloadSchema = Schema.Struct({
  ok: Schema.Literal(true),
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        path: Schema.optional(Schema.String),
        bytes: Schema.Number,
        sha256: Schema.NonEmptyString,
      })
    )
  ),
});

export const ErrPayloadSchema = Schema.Struct({
  code: Schema.Literals(["PIN", "LIMITS", "HASH", "TIMEOUT", "UNKNOWN"]),
  message: Schema.optional(Schema.String),
  fileIndex: Schema.optional(Schema.Number),
});

export class PdwpCodec {
  static encodeFrame(type: FrameType, payload: Buffer): Buffer {
    if (payload.length + 1 > MAX_PDWP_FRAME_BYTES) {
      throw new PdwpProtocolError("PDWP frame exceeds the maximum length");
    }
    const header = Buffer.alloc(5);
    header.writeUInt32LE(payload.length + 1, 0);
    header.writeUInt8(type, 4);
    return Buffer.concat([header, payload]);
  }

  static encodeJsonFrame(type: FrameType, payloadObj: unknown): Buffer {
    const jsonBuf = Buffer.from(JSON.stringify(payloadObj), "utf-8");
    return this.encodeFrame(type, jsonBuf);
  }

  static encodeFileChunkFrame(fileIndex: number, offset: number, chunk: Buffer): Buffer {
    const header = Buffer.alloc(10);
    header.writeUInt16LE(fileIndex, 0);
    header.writeBigUInt64LE(BigInt(offset), 2);
    const payload = Buffer.concat([header, chunk]);
    return this.encodeFrame(FrameType.FILE, payload);
  }

  static parseFileChunkFrame(payload: Buffer): { fileIndex: number; offset: number; chunk: Buffer } {
    if (payload.length < 10) {
      throw new PdwpProtocolError("File chunk payload too short");
    }
    const fileIndex = payload.readUInt16LE(0);
    const offset = Number(payload.readBigUInt64LE(2));
    const chunk = payload.subarray(10);
    return { fileIndex, offset, chunk };
  }
}

export class PdwpFrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): ParsedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_PDWP_BUFFER_BYTES) {
      this.buffer = Buffer.alloc(0);
      throw new PdwpProtocolError("PDWP parser buffer exceeds the maximum length");
    }
    const frames: ParsedFrame[] = [];

    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32LE(0);
      if (length < 1 || length > MAX_PDWP_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new PdwpProtocolError("PDWP frame length is invalid");
      }
      const totalFrameLength = length + 4; // 4 bytes for length prefix

      if (this.buffer.length < totalFrameLength) {
        break;
      }

      const type = this.buffer.readUInt8(4) as FrameType;
      if (!Object.values(FrameType).includes(type)) {
        this.buffer = Buffer.alloc(0);
        throw new PdwpProtocolError("PDWP frame type is invalid");
      }
      const rawPayload = this.buffer.subarray(5, totalFrameLength);
      this.buffer = this.buffer.subarray(totalFrameLength);

      let payload: unknown = rawPayload;
      if (type === FrameType.FILE) {
        payload = PdwpCodec.parseFileChunkFrame(rawPayload);
      } else {
        try {
          payload = JSON.parse(rawPayload.toString("utf-8")) as unknown;
        } catch (cause) {
          throw new PdwpProtocolError(`Invalid PDWP JSON payload: ${cause instanceof Error ? cause.message : "unknown error"}`);
        }
      }

      frames.push({ type, payload, rawBuffer: rawPayload });
    }

    return frames;
  }
}
