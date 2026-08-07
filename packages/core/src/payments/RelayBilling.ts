import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExternalServiceError } from "../effect/runtime.js";

export interface RelayBillingStrategy {
  scheme: "upto" | "disabled";
  calculateFee(bytes: number): number;
  calculateMaxCapFee(capGB: number): number;
}

/**
 * Relay pricing tiers, in one place so they are trivial to adjust.
 *
 * The free tier boundary is fixed at 5MB. The paid tiers above it are the
 * pre-existing schedule shifted up past the free tier rather than new numbers,
 * which keeps the curve monotonic; they remain provisional and are expected to
 * be re-tuned, so keep them named here instead of inlining them.
 */
export const RELAY_FREE_TIER_BYTES = 5 * 1024 * 1024;
export const RELAY_TIER_1_MAX_BYTES = 50 * 1024 * 1024;
export const RELAY_TIER_1_USDC = 0.01;
export const RELAY_TIER_2_MAX_BYTES = 500 * 1024 * 1024;
export const RELAY_TIER_2_USDC = 0.02;
export const RELAY_VARIABLE_RATE_USDC_PER_GB = 0.03;

/**
 * True once a relay transfer is large enough to cost money. This is the only
 * condition under which a wallet is needed at all — below it, relay is free and
 * no payment authorization should ever be requested.
 */
export function relayRequiresPayment(bytes: number): boolean {
  return bytes > RELAY_FREE_TIER_BYTES;
}

/**
 * Relay bytes at which the payment pre-authorization should be prepared. The
 * x402 "upto" scheme pre-authorizes a cap and settles the real byte count
 * afterwards, so the authorization has to exist slightly before the first
 * billable byte — this fires while a transfer is trending at the free-tier
 * ceiling rather than after it has already blown through it.
 */
export const RELAY_AUTHORIZATION_TRIGGER_BYTES = Math.floor(RELAY_FREE_TIER_BYTES * 0.8);

/** True once relayed bytes are trending over the free tier (see above). */
export function relayNeedsAuthorization(relayBytes: number): boolean {
  return relayBytes >= RELAY_AUTHORIZATION_TRIGGER_BYTES;
}

export function calculateRelayFee(bytes: number): number {
  if (!relayRequiresPayment(bytes)) return 0;

  if (bytes <= RELAY_TIER_1_MAX_BYTES) {
    return RELAY_TIER_1_USDC;
  }
  if (bytes <= RELAY_TIER_2_MAX_BYTES) {
    return RELAY_TIER_2_USDC;
  }
  const variableRate = (bytes / 1e9) * RELAY_VARIABLE_RATE_USDC_PER_GB;
  const rawFee = Math.max(RELAY_TIER_2_USDC, variableRate);
  // ceil6: ceil to 6 decimal places (USDC 6 decimals)
  return Math.ceil(rawFee * 1e6) / 1e6;
}

export function calculateMaxCapAuthorization(capGB = 2): number {
  const bytes = capGB * 1e9;
  return calculateRelayFee(bytes);
}

export class UptoBillingStrategy implements RelayBillingStrategy {
  readonly scheme = "upto" as const;

  calculateFee(bytes: number): number {
    return calculateRelayFee(bytes);
  }

  calculateMaxCapFee(capGB: number): number {
    return calculateMaxCapAuthorization(capGB);
  }
}

export class DisabledBillingStrategy implements RelayBillingStrategy {
  readonly scheme = "disabled" as const;

  calculateFee(_bytes: number): number {
    return 0;
  }

  calculateMaxCapFee(_capGB: number): number {
    return 0;
  }
}

export interface FacilitatorSupportedKind {
  scheme: string;
  network: string;
}

const FacilitatorSupportedResponse = Schema.Struct({
  kinds: Schema.Array(Schema.Struct({ scheme: Schema.String, network: Schema.String })),
});

export function discoverFacilitatorSupport(
  facilitatorUrl: string,
  network: string,
  isPreview = false
): Effect.Effect<"upto" | "disabled", never> {
  if (isPreview || network === "eip155:84532" || network === "base-sepolia") {
    // Public preview hard-codes upto for base-sepolia per PRD §5 & research
    return Effect.succeed("upto");
  }

  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${facilitatorUrl}/supported`);
      if (!res.ok) throw new Error(`Facilitator discovery failed with HTTP ${res.status}`);
      return Schema.decodeUnknownSync(FacilitatorSupportedResponse)(await res.json());
    },
    catch: (cause) => new ExternalServiceError({ cause, operation: "discover support", retryable: true, service: "x402 facilitator" }),
  }).pipe(Effect.map((data) => {
    const kinds = data.kinds;

    const hasUpto = kinds.some(
      (k) => k.scheme === "upto" && (k.network === network || k.network === "eip155:8453")
    );
    if (hasUpto) return "upto" as const;

    return "disabled" as const;
  }), Effect.orElseSucceed(() => "disabled" as const));
}
