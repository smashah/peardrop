import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { privateKeyToAccount } from "viem/accounts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RELAY_FREE_TIER_BYTES, relayNeedsAuthorization } from "./RelayBilling.js";

export class WalletError extends Data.TaggedError("WalletError")<{
  readonly message: string;
  /**
   * True when the operator can fix this themselves (no wallet configured, bad
   * key). Worker- and facilitator-side failures are not actionable locally, so
   * callers can warn about those instead of aborting a live transfer.
   */
  readonly userActionable?: boolean;
}> {}

const WalletFileSchema = Schema.Struct({ privateKey: Schema.NonEmptyString });
const PaymentRequirementSchema = Schema.Struct({
  scheme: Schema.NonEmptyString,
  network: Schema.NonEmptyString,
  asset: Schema.NonEmptyString,
  amount: Schema.NonEmptyString,
  payTo: Schema.NonEmptyString,
  maxTimeoutSeconds: Schema.Number,
  extra: Schema.Record(Schema.String, Schema.Unknown),
});
const PaymentRequiredSchema = Schema.Struct({
  x402Version: Schema.Number,
  resource: Schema.Struct({ url: Schema.NonEmptyString }),
  accepts: Schema.Array(PaymentRequirementSchema),
  extensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const RelayRequirementsResponseSchema = Schema.Struct({
  paymentRequired: PaymentRequiredSchema,
  relayCapGB: Schema.Number,
});

const walletDirectory = () => join(homedir(), ".peardrop");
export const walletPath = () => join(walletDirectory(), "wallet.json");

const validatePrivateKey = (privateKey: string) =>
  /^0x[0-9a-fA-F]{64}$/.test(privateKey)
    ? Effect.succeed(privateKey as `0x${string}`)
    : Effect.fail(new WalletError({ message: "Wallet private key must be a 32-byte 0x-prefixed hex value", userActionable: true }));

export const loadWalletPrivateKey = Effect.gen(function* () {
  const environmentKey = yield* Config.string("PEARDROP_WALLET_PRIVATE_KEY").pipe(Config.withDefault(""));
  if (environmentKey) return Redacted.make(yield* validatePrivateKey(environmentKey));
  const file = walletPath();
  if (!existsSync(file)) {
    return yield* Effect.fail(new WalletError({ message: "No wallet configured; set PEARDROP_WALLET_PRIVATE_KEY or run npx --yes @peardrop/cli@latest wallet configure", userActionable: true }));
  }
  const raw = yield* Effect.try({
    try: () => readFileSync(file, "utf8"),
    catch: () => new WalletError({ message: "Could not read PearDrop wallet configuration" }),
  });
  const json = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => new WalletError({ message: "PearDrop wallet configuration is invalid JSON", userActionable: true }),
  });
  const decoded = yield* Schema.decodeUnknownEffect(WalletFileSchema)(json).pipe(
    Effect.mapError(() => new WalletError({ message: "PearDrop wallet configuration is invalid", userActionable: true }))
  );
  return Redacted.make(yield* validatePrivateKey(decoded.privateKey));
});

export const saveWalletPrivateKey = (privateKey: string) =>
  Effect.gen(function* () {
    const validated = yield* validatePrivateKey(privateKey);
    yield* Effect.try({
      try: () => {
        mkdirSync(walletDirectory(), { recursive: true, mode: 0o700 });
        writeFileSync(walletPath(), JSON.stringify({ privateKey: validated }), { mode: 0o600 });
        chmodSync(walletPath(), 0o600);
      },
      catch: () => new WalletError({ message: "Could not write PearDrop wallet configuration" }),
    });
  });

export const fetchRelayPaymentRequired = (workerUrl: string, relayCapGb: number) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${workerUrl.replace(/\/$/, "")}/api/relay-requirements?relayCapGB=${relayCapGb}`);
      if (!response.ok) throw new Error(`Relay payment requirements unavailable with HTTP ${response.status}`);
      const decoded = Schema.decodeUnknownSync(RelayRequirementsResponseSchema)(await response.json());
      return decoded.paymentRequired as PaymentRequired;
    },
    catch: (cause) => new WalletError({
      message: cause instanceof Error ? cause.message : "Relay payment requirements are unavailable",
    }),
  });

/** Whether a wallet exists at all, without loading or validating the key. */
export const walletIsConfigured = Effect.gen(function* () {
  const environmentKey = yield* Config.string("PEARDROP_WALLET_PRIVATE_KEY").pipe(Config.withDefault(""));
  return Boolean(environmentKey) || existsSync(walletPath());
});

const freeTierMB = RELAY_FREE_TIER_BYTES / (1024 * 1024);

export const RELAY_OVERAGE_WALLET_MESSAGE =
  `Relay transfer would exceed the free ${freeTierMB}MB tier and no wallet is configured — ` +
  `run \`npx --yes @peardrop/cli@latest wallet configure\` (or set PEARDROP_WALLET_PRIVATE_KEY), or keep the transfer under ${freeTierMB}MB.`;

export const createRelayAuthorization = (workerUrl: string, relayCapGb: number) =>
  Effect.gen(function* () {
    const paymentRequired = yield* fetchRelayPaymentRequired(workerUrl, relayCapGb);
    const privateKey = yield* loadWalletPrivateKey;
    const account = privateKeyToAccount(Redacted.value(privateKey));
    const network = paymentRequired.accepts[0]?.network;
    if (!network) return yield* Effect.fail(new WalletError({ message: "Worker returned no relay payment requirements" }));
    const client = new x402Client().register(network, new UptoEvmScheme(account));
    return yield* Effect.tryPromise({
      try: () => client.createPaymentPayload(paymentRequired),
      catch: () => new WalletError({ message: "Could not sign relay payment authorization" }),
    });
  }) as Effect.Effect<PaymentPayload, WalletError>;

export interface RelayOverageAuthorizationOptions {
  readonly workerUrl: string;
  readonly relayCapGb: number;
  /** Bytes the Worker has actually relayed for this tunnel so far. */
  readonly relayBytes: number;
}

/**
 * Lazy relay authorization. Returns `null` — touching neither the wallet nor
 * the Worker — while a relayed transfer is still inside the free tier, so
 * `--allow-relay` on its own never costs a round-trip or requires a wallet.
 * Only once relayed bytes trend over the free tier does this load the wallet,
 * fetch payment requirements, and sign the "upto" pre-authorization.
 */
export const authorizeRelayOverage = (
  options: RelayOverageAuthorizationOptions
): Effect.Effect<PaymentPayload | null, WalletError> =>
  Effect.gen(function* () {
    if (!relayNeedsAuthorization(options.relayBytes)) return null;
    if (!(yield* walletIsConfigured)) {
      return yield* Effect.fail(new WalletError({ message: RELAY_OVERAGE_WALLET_MESSAGE, userActionable: true }));
    }
    return yield* createRelayAuthorization(options.workerUrl, options.relayCapGb);
  }) as Effect.Effect<PaymentPayload | null, WalletError>;
