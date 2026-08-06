import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TicketError } from "../effect/errors.js";

export interface RelayTicketClaims {
  readonly slug: string;
  readonly publicKey: string;
  readonly capBytes: number;
  readonly exp: number;
}

const RelayTicketClaimsSchema = Schema.Struct({
  slug: Schema.NonEmptyString,
  publicKey: Schema.NonEmptyString,
  capBytes: Schema.Number.check(Schema.isGreaterThan(0)),
  exp: Schema.Int.check(Schema.isGreaterThan(0)),
});

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (str: string): Uint8Array<ArrayBuffer> => {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

function parseClaims(payload: Uint8Array): RelayTicketClaims {
  let unknownClaims: unknown;
  try {
    unknownClaims = JSON.parse(new TextDecoder().decode(payload));
  } catch (cause) {
    throw new TicketError({ message: `Malformed relay ticket claims: ${String(cause)}` });
  }
  let claims: RelayTicketClaims;
  try {
    claims = Schema.decodeUnknownSync(RelayTicketClaimsSchema)(unknownClaims);
  } catch (cause) {
    throw new TicketError({ message: `Invalid relay ticket claims: ${String(cause)}` });
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new TicketError({ message: "Relay ticket expired" });
  }
  return claims;
}

export async function signRelayTicket(claims: RelayTicketClaims, secret: string): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const key = await importHmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, payload);
  return `${toBase64Url(payload)}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyRelayTicket(ticket: string, secret: string): Promise<RelayTicketClaims> {
  const parts = ticket.split(".");
  if (parts.length !== 2) {
    throw new TicketError({ message: "Malformed relay ticket" });
  }
  const payload = fromBase64Url(parts[0]!);
  const sig = fromBase64Url(parts[1]!);
  const key = await importHmacKey(secret, ["verify"]);
  // ponytail: fresh Uint8Arrays from fromBase64Url are already valid BufferSource
  const valid = await crypto.subtle.verify("HMAC", key, sig, payload);
  if (!valid) {
    throw new TicketError({ message: "Invalid relay ticket signature" });
  }
  return parseClaims(payload);
}

export const verifyRelayTicketEffect = (ticket: string, secret: string) =>
  Effect.tryPromise({
    try: () => verifyRelayTicket(ticket, secret),
    catch: (cause) =>
      cause instanceof TicketError ? cause : new TicketError({ message: "Relay ticket verification failed" }),
  });
