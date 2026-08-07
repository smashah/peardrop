/** Post-receive hook: runs an operator-supplied command once a drop is confirmed written to disk. */
import { spawn, type ChildProcess } from "node:child_process";

/** Absolute target path the drop was written to (directory or single file). */
export const ON_RECEIVE_TARGET_PATH_ENV = "PEARDROP_TARGET_PATH";
/** Newline-separated absolute paths of the files this drop delivered. */
export const ON_RECEIVE_FILE_PATHS_ENV = "PEARDROP_FILE_PATHS";
/** Number of files this drop delivered. */
export const ON_RECEIVE_FILE_COUNT_ENV = "PEARDROP_FILE_COUNT";

export interface OnReceiveHookFile {
  readonly name: string;
  readonly path?: string;
}

export interface OnReceiveHookResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the hook could not be spawned at all (bad shell, ENOENT, …). */
  readonly error?: string;
}

export interface RunOnReceiveHookOptions {
  readonly command: string;
  readonly targetPath: string;
  readonly files: ReadonlyArray<OnReceiveHookFile>;
  readonly env?: NodeJS.ProcessEnv;
  /** Sink for hook output and the failure notice; defaults to this process's stderr. */
  readonly log?: (chunk: string) => void;
}

/**
 * Runs the `on_receive` command with the drop's paths in the environment.
 *
 * The command itself is operator-authored (TOML spec or `--on-receive`) so it runs
 * through a shell, but every drop-derived value — the target path, the delivered file
 * paths — is passed in the environment and never on argv, so nothing a sender controls
 * ends up visible in `ps`. The raw secret value is never passed at all; the hook reads
 * it from the file the writer already chmod-600'd.
 *
 * Never throws and never rejects: the drop has already been delivered, so a failing
 * hook is reported, not propagated.
 */
export function runOnReceiveHook(options: RunOnReceiveHookOptions): Promise<OnReceiveHookResult> {
  const log = options.log ?? ((chunk: string) => void process.stderr.write(chunk));
  const paths = options.files.map((file) => file.path).filter((path): path is string => typeof path === "string" && path.length > 0);

  return new Promise<OnReceiveHookResult>((resolve) => {
    let settled = false;
    const settle = (result: OnReceiveHookResult) => {
      if (settled) return;
      settled = true;
      if (!result.ok) {
        const reason = result.error ?? (result.signal ? `killed by ${result.signal}` : `exit code ${result.exitCode}`);
        // The drop is already on disk and chmod-600'd — the hook is a side effect,
        // so this is a loud warning rather than a rollback.
        log(`peardrop: on_receive hook failed (${reason}). The drop was delivered and is unaffected.\n`);
      }
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(options.command, {
        shell: true,
        // stdout is piped rather than inherited so hook chatter can never interleave
        // with the CLI's own --json line on stdout.
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...(options.env ?? process.env),
          [ON_RECEIVE_TARGET_PATH_ENV]: options.targetPath,
          [ON_RECEIVE_FILE_PATHS_ENV]: paths.join("\n"),
          [ON_RECEIVE_FILE_COUNT_ENV]: String(paths.length),
        },
      });
    } catch (cause) {
      settle({ ok: false, exitCode: null, signal: null, error: cause instanceof Error ? cause.message : String(cause) });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => log(chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => log(chunk.toString("utf-8")));
    child.once("error", (cause: Error) => settle({ ok: false, exitCode: null, signal: null, error: cause.message }));
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      settle({ ok: code === 0, exitCode: code, signal });
    });
  });
}
