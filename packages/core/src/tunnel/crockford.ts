/**
 * Crockford base32: digits plus lowercase letters with `i`, `l`, `o` and `u`
 * removed, so nothing in the alphabet can be misread as something else when a
 * human types it from a screen or reads it down a phone. Shared by the drop
 * slug's short code and by key fingerprints so the two never drift apart.
 */
export const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
