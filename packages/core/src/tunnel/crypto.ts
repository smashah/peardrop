const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

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

export function generateSlug(bytesLength = 16): string {
  const buf = randomBytes(bytesLength);
  let result = "";
  let value = 0;
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | (buf[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      result += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31]!;
  }
  return result.slice(0, 26);
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
