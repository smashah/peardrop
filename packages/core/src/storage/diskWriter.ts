import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, mkdirSync, renameSync, unlinkSync, WriteStream } from "node:fs";
import { dirname } from "node:path";
import { createGunzip } from "node:zlib";
import * as Effect from "effect/Effect";
import { FileWriteError, HashError } from "../effect/errors.js";
import { resolveTargetLocation, type TargetPathResolution } from "./targetPath.js";

export interface ReceivedFileResult {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export class DiskWriter {
  private targetRes: TargetPathResolution;
  private currentPartPath: string | null = null;
  private currentWriteStream: WriteStream | null = null;
  private currentHash = createHash("sha256");
  private currentBytes = 0;
  private receivedFiles: ReceivedFileResult[] = [];

  constructor(targetSpec: string) {
    this.targetRes = resolveTargetLocation(targetSpec);
  }

  startFile(senderFilename: string, isGzip = false): string {
    const finalPath = this.targetRes.resolveFilePath(senderFilename);
    const partPath = `${finalPath}.part`;
    this.currentPartPath = partPath;
    this.currentBytes = 0;
    this.currentHash = createHash("sha256");

    mkdirSync(dirname(finalPath), { recursive: true });

    this.currentWriteStream = createWriteStream(partPath, { flags: "w", mode: 0o600 });
    return finalPath;
  }

  writeChunk(chunk: Buffer, isGzip = false): void {
    if (!this.currentWriteStream) {
      throw new Error("No file open for writing");
    }
    this.currentBytes += chunk.length;
    this.currentHash.update(chunk);
    this.currentWriteStream.write(chunk);
  }

  finalizeFile(senderFilename: string, expectedSha256: string): Effect.Effect<ReceivedFileResult, FileWriteError | HashError> {
    if (!this.currentWriteStream || !this.currentPartPath) {
      return Effect.fail(new FileWriteError({ message: "No file active" }));
    }

    const stream = this.currentWriteStream;
    const partPath = this.currentPartPath;
    const writer = this;
    return Effect.gen(function* () {
      yield* Effect.callback<void, FileWriteError>((resume) => {
        const onError = (cause: Error) => resume(Effect.fail(new FileWriteError({ message: cause.message, path: partPath })));
        stream.once("error", onError);
        stream.end(() => resume(Effect.void));
        return Effect.sync(() => stream.off("error", onError));
      });

      const calculatedSha256 = writer.currentHash.digest("hex");
      if (expectedSha256 && calculatedSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        writer.abortCurrentFile();
        return yield* Effect.fail(new HashError({
          message: `SHA256 mismatch for ${senderFilename}`,
          expected: expectedSha256,
          actual: calculatedSha256,
        }));
      }

      const finalPath = writer.targetRes.resolveFilePath(senderFilename);
      yield* Effect.try({
        try: () => {
          renameSync(partPath, finalPath);
          chmodSync(finalPath, 0o600);
        },
        catch: (cause) => new FileWriteError({ message: String(cause), path: finalPath }),
      });

      const result: ReceivedFileResult = { name: senderFilename, path: finalPath, bytes: writer.currentBytes, sha256: calculatedSha256 };
      writer.receivedFiles.push(result);
      writer.currentPartPath = null;
      writer.currentWriteStream = null;
      return result;
    });
  }

  abortCurrentFile(): void {
    if (this.currentWriteStream) {
      this.currentWriteStream.destroy();
      this.currentWriteStream = null;
    }
    if (this.currentPartPath) {
      Effect.runSync(Effect.try({
        try: () => unlinkSync(this.currentPartPath!),
        catch: (cause) => new FileWriteError({ message: String(cause), path: this.currentPartPath! }),
      }).pipe(Effect.ignore));
      this.currentPartPath = null;
    }
  }

  getReceivedFiles(): ReceivedFileResult[] {
    return this.receivedFiles;
  }
}
