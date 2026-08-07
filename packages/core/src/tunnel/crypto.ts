import { CROCKFORD_ALPHABET } from "./crockford.js";

function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeOwnerToken(slug: string, pepper: string): Promise<string> {
  return hmacSha256Hex(pepper, `owner:${slug}`);
}

export async function computeOwnerTokenHash(ownerToken: string, pepper: string): Promise<string> {
  return hmacSha256Hex(pepper, `hash:${ownerToken}`);
}

export function generateFingerprint(publicKeyHex: string): string {
  const cleanKey = publicKeyHex.replace(/^0x/i, "").toLowerCase();
  let result = "";
  for (let i = 0; i < Math.min(cleanKey.length, 16); i += 2) {
    const byteVal = Number.parseInt(cleanKey.slice(i, i + 2), 16);
    if (!Number.isNaN(byteVal)) {
      result += CROCKFORD_ALPHABET[byteVal & 31]!;
    }
  }
  return (result || cleanKey).slice(0, 8).toUpperCase();
}

export function generateSingleUseToken(): string {
  return Array.from(randomBytes(16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
