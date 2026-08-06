import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type SessionStatus = "waiting" | "delivered" | "cancelled" | "expired";

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
  status: Schema.Literals(["waiting", "delivered", "cancelled", "expired"]),
  pin: Schema.optional(Schema.String),
  files: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, sha256: Schema.String }))
  ),
  relayBytesBilled: Schema.optional(Schema.Number),
});

const baseDir = () => join(homedir(), ".peardrop", "tunnels");

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
