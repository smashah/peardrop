import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type SessionStatus = "waiting" | "delivered" | "cancelled" | "expired" | "failed";

export interface TunnelSession {
  readonly tunnelId: string;
  readonly url: string;
  readonly fingerprint: string;
  readonly target: string;
  readonly expiresAt: number;
  readonly relayAllowed: boolean;
  readonly ownerToken?: string;
  readonly workerUrl?: string;
  readonly mode: "remote" | "local";
  readonly status: SessionStatus;
  readonly pin?: string;
  readonly files?: ReadonlyArray<{ name: string; path: string; sha256: string }>;
  readonly relayBytesBilled?: number;
  /** Receiver process id, so status/cancel can see whether it is still alive. */
  readonly pid?: number;
  /** Where a detached receiver appends its --json event stream. */
  readonly logPath?: string;
}

const TunnelSessionSchema = Schema.Struct({
  tunnelId: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  fingerprint: Schema.NonEmptyString,
  target: Schema.String,
  expiresAt: Schema.Number,
  relayAllowed: Schema.Boolean,
  ownerToken: Schema.optional(Schema.String),
  workerUrl: Schema.optional(Schema.String),
  mode: Schema.Literals(["remote", "local"]),
  status: Schema.Literals(["waiting", "delivered", "cancelled", "expired", "failed"]),
  pin: Schema.optional(Schema.String),
  files: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, sha256: Schema.String }))
  ),
  relayBytesBilled: Schema.optional(Schema.Number),
  pid: Schema.optional(Schema.Number),
  logPath: Schema.optional(Schema.String),
});

/**
 * Where session files live. `PEARDROP_HOME` relocates the whole `~/.peardrop`
 * tree, so a test or a sandboxed run never touches a real receiver's sessions.
 */
export const sessionsDir = (): string =>
  process.env.PEARDROP_HOME ? join(process.env.PEARDROP_HOME, "tunnels") : join(homedir(), ".peardrop", "tunnels");

const baseDir = sessionsDir;

const ensureDir = () => {
  mkdirSync(baseDir(), { recursive: true });
};

const decodeSession = (input: string): TunnelSession =>
  Schema.decodeUnknownSync(TunnelSessionSchema)(JSON.parse(input) as unknown);

export interface SessionStoreService {
  readonly save: (session: TunnelSession) => Effect.Effect<void>;
  readonly load: (tunnelId: string) => Effect.Effect<TunnelSession | null>;
  readonly updateStatus: (
    tunnelId: string,
    status: SessionStatus,
    extra?: Partial<TunnelSession>
  ) => Effect.Effect<boolean>;
  readonly remove: (tunnelId: string) => Effect.Effect<boolean>;
  readonly changes: SubscriptionRef.SubscriptionRef<ReadonlyMap<string, TunnelSession>>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreService>()("@peardrop/core/SessionStore") {}

export const SessionStoreLive = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const changes = yield* SubscriptionRef.make<ReadonlyMap<string, TunnelSession>>(new Map());
    const save = (session: TunnelSession) =>
      Effect.sync(() => {
        ensureDir();
        writeFileSync(join(baseDir(), `${session.tunnelId}.json`), JSON.stringify(session, null, 2), { mode: 0o600 });
      }).pipe(
        Effect.andThen(
          SubscriptionRef.update(changes, (sessions) => new Map(sessions).set(session.tunnelId, session))
        )
      );
    const load = (tunnelId: string) =>
      Effect.sync(() => {
        const file = join(baseDir(), `${tunnelId}.json`);
        return existsSync(file) ? decodeSession(readFileSync(file, "utf-8")) : null;
      }).pipe(
        Effect.tap((session) =>
          session
            ? SubscriptionRef.update(changes, (sessions) => new Map(sessions).set(tunnelId, session))
            : Effect.void
        )
      );
    const updateStatus = (tunnelId: string, status: SessionStatus, extra?: Partial<TunnelSession>) =>
      load(tunnelId).pipe(
        Effect.flatMap((session) => (session ? save({ ...session, ...extra, status }).pipe(Effect.as(true)) : Effect.succeed(false)))
      );
    const remove = (tunnelId: string) =>
      Effect.sync(() => {
        const file = join(baseDir(), `${tunnelId}.json`);
        if (!existsSync(file)) return false;
        unlinkSync(file);
        return true;
      }).pipe(
        Effect.tap((removed) =>
          removed
            ? SubscriptionRef.update(changes, (sessions) => {
                const next = new Map(sessions);
                next.delete(tunnelId);
                return next;
              })
            : Effect.void
        )
      );
    return { save, load, updateStatus, remove, changes };
  })
);

export const saveSession = (session: TunnelSession) =>
  Effect.flatMap(SessionStore, (store) => store.save(session)).pipe(Effect.provide(SessionStoreLive));

export const loadSession = (tunnelId: string) =>
  Effect.flatMap(SessionStore, (store) => store.load(tunnelId)).pipe(Effect.provide(SessionStoreLive));

export const updateSessionStatus = (
  tunnelId: string,
  status: SessionStatus,
  extra?: Partial<TunnelSession>
) =>
  Effect.flatMap(SessionStore, (store) => store.updateStatus(tunnelId, status, extra)).pipe(Effect.provide(SessionStoreLive));

export const removeSession = (tunnelId: string) =>
  Effect.flatMap(SessionStore, (store) => store.remove(tunnelId)).pipe(Effect.provide(SessionStoreLive));

/**
 * Whether `pid` is a process this user can still see. `process.kill(pid, 0)`
 * sends no signal; EPERM means the pid exists but belongs to someone else, so
 * that counts as alive — only ESRCH ("no such process") means it is gone.
 */
export const isProcessAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Statuses a session never leaves, so its file is history rather than state. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<SessionStatus>(["delivered", "cancelled", "expired", "failed"]);

/** How long a finished session's file is kept around for `status`/`doctor` to explain what happened. */
export const FINISHED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PruneSessionsOptions {
  readonly now?: number;
  readonly isAlive?: (pid?: number) => boolean;
  readonly finishedTtlMs?: number;
  /** Count what would go without deleting anything, for `doctor`'s report. */
  readonly dryRun?: boolean;
}

export interface PruneSessionsResult {
  /** Session files considered. */
  readonly scanned: number;
  /** Session files deleted — or, under `dryRun`, the number that would be. */
  readonly pruned: number;
}

/**
 * Deletes the session files nothing will ever revisit. A receiver killed
 * uncleanly (SIGKILL, machine sleep, a closed terminal) never gets to write a
 * terminal status, so its file sits at "waiting" forever and the directory
 * grows without bound (smashah/peardrop#106). Two things go: a "waiting"
 * session past its expiry whose receiver is no longer running, and any
 * finished session whose file has not been touched for `finishedTtlMs`.
 *
 * A live pid is never touched, whatever the file says, and an unreadable or
 * half-written file is left alone for a human to look at.
 */
export const pruneStaleSessions = (options: PruneSessionsOptions = {}): Effect.Effect<PruneSessionsResult> =>
  Effect.sync(() => {
    const now = options.now ?? Date.now();
    const alive = options.isAlive ?? isProcessAlive;
    const finishedTtlMs = options.finishedTtlMs ?? FINISHED_SESSION_TTL_MS;
    const dir = baseDir();
    if (!existsSync(dir)) return { scanned: 0, pruned: 0 };

    let scanned = 0;
    let pruned = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      scanned += 1;
      const file = join(dir, name);
      try {
        const session = JSON.parse(readFileSync(file, "utf8")) as Partial<TunnelSession>;
        if (alive(session.pid)) continue;
        const expiredWaiting =
          session.status === "waiting" && typeof session.expiresAt === "number" && session.expiresAt < now;
        const finishedLongAgo =
          typeof session.status === "string" &&
          TERMINAL_STATUSES.has(session.status) &&
          statSync(file).mtimeMs < now - finishedTtlMs;
        if (!expiredWaiting && !finishedLongAgo) continue;
        if (!options.dryRun) unlinkSync(file);
        pruned += 1;
      } catch {
        // Unreadable or mid-write: leave it, a sweep must never destroy evidence.
      }
    }
    return { scanned, pruned };
  });
