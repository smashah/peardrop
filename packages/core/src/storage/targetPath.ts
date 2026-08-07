import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { statSync } from "node:fs";
import * as Effect from "effect/Effect";

export function sanitizeFilename(filename: string): string {
  // Control characters are stripped as well as directories: a sender-chosen name
  // containing a newline would otherwise forge entries in the newline-separated
  // PEARDROP_FILE_PATHS handed to post-receive hooks.
  const base = basename(filename).replace(/[\x00-\x1f\x7f]/g, "_");
  if (!base || base === "." || base === "..") {
    throw new Error(`Invalid filename: ${filename}`);
  }
  return base;
}

export interface TargetPathResolution {
  isDir: boolean;
  basePath: string;
  resolveFilePath(senderFilename: string): string;
}

export function resolveTargetLocation(targetSpec: string): TargetPathResolution {
  const normalized = normalize(targetSpec);
  const absolutePath = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);

  let isDir = targetSpec.endsWith("/") || targetSpec.endsWith("\\");
  if (!isDir) {
    isDir = Effect.runSync(Effect.try({
      try: () => statSync(absolutePath).isDirectory(),
      catch: (cause) => new Error(String(cause)),
    }).pipe(Effect.orElseSucceed(() => false)));
  }

  return {
    isDir,
    basePath: absolutePath,
    resolveFilePath(senderFilename: string): string {
      const cleanName = sanitizeFilename(senderFilename);
      if (isDir) {
        const fullPath = join(absolutePath, cleanName);
        if (!fullPath.startsWith(absolutePath)) {
          throw new Error("Target traversal detected");
        }
        return fullPath;
      }
      return absolutePath;
    },
  };
}
