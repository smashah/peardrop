import { createHmac, timingSafeEqual } from "node:crypto";
import * as Schema from "effect/Schema";
import { TicketError } from "../effect/errors.js";
import type { RelayTicketClaims } from "./RelayTicket.js";

const RelayTicketClaimsSchema = Schema.Struct({
  slug: Schema.NonEmptyString,
  publicKey: Schema.NonEmptyString,
  capBytes: Schema.Number.check(Schema.isGreaterThan(0)),
  exp: Schema.Int.check(Schema.isGreaterThan(0)),
});

const toBase64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (str: string): Buffer => {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
};

/** Synchronous ticket verification for the Node relay process. */
export function verifyRelayTicketSync(ticket: string, secret: string): RelayTicketClaims {
  const parts = ticket.split(".");
  if (parts.length !== 2) {
    throw new TicketError({ message: "Malformed relay ticket" });
  }
  const payload = fromBase64Url(parts[0]!);
  const sig = fromBase64Url(parts[1]!);
  const expected = createHmac("sha256", secret).update(payload).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw new TicketError({ message: "Invalid relay ticket signature" });
  }
  let unknownClaims: unknown;
  try {
    unknownClaims = JSON.parse(payload.toString("utf-8"));
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

export function signRelayTicketSync(claims: RelayTicketClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf-8");
  const sig = createHmac("sha256", secret).update(payload).digest();
  return `${toBase64Url(payload)}.${toBase64Url(sig)}`;
}
