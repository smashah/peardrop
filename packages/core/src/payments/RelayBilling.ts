import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExternalServiceError } from "../effect/runtime.js";

export interface RelayBillingStrategy {
  scheme: "upto" | "disabled";
  calculateFee(bytes: number): number;
  calculateMaxCapFee(capGB: number): number;
}

export function calculateRelayFee(bytes: number): number {
  if (bytes <= 0) return 0;
  const fiftyMB = 50 * 1024 * 1024;
  const fiveHundredMB = 500 * 1024 * 1024;

  if (bytes <= fiftyMB) {
    return 0.01;
  }
  if (bytes <= fiveHundredMB) {
    return 0.02;
  }
  const variableRate = (bytes / 1e9) * 0.03;
  const rawFee = Math.max(0.02, variableRate);
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
