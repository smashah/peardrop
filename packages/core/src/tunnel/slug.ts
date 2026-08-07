import { CROCKFORD_ALPHABET } from "./crockford.js";

/**
 * Word-based drop slugs — `silent-moss-7f2`.
 *
 * ## What a slug is, and what it is not
 *
 * A slug is a *display and routing identifier*: the thing a human reads off a
 * terminal, types into a phone, or says out loud. It names a drop; it does not
 * authorize one. The cryptographic boundary lives underneath it and is
 * unchanged by this format:
 *
 * - **Local (Mode 3, `BridgeServer`)** — `generateSingleUseToken()` produces a
 *   128-bit single-use token that every upload must present and that the server
 *   validates. The slug is only the URL path the drop page is served on.
 * - **Remote/relay** — the HMAC owner-token scheme (`computeOwnerToken` /
 *   `computeOwnerTokenHash` in `crypto.ts`) still decides who may mutate or
 *   claim a tunnel. Only the slug's *shape* changed, never what it authorizes.
 *
 * ## Entropy, stated honestly
 *
 * 128 adjectives x 128 nouns x 32^3 codes = 2^7 x 2^7 x 2^15 = **2^29**
 * (~5.4 x 10^8) distinct slugs. That is deliberately small — it buys a name you
 * can read aloud — and it is *not* enough to stand alone as a secret. Anywhere a
 * slug is the only thing between an attacker and a payload, that flow is
 * misdesigned: pair it with the token or owner-token check above. The birthday
 * bound also means collisions are real at scale (~23k live slugs gives a ~50%
 * chance of one), so any store that must keep slugs unique should allocate
 * through `generateUniqueSlug()` rather than assuming `generateSlug()` is unique.
 */

/**
 * Deliberately small, boring corpus: 4-6 letters, lowercase ASCII only, no
 * profanity, no homophones (`fair`/`fare`, `plain`/`plane`, `right`/`write`),
 * nothing that changes spelling between dialects (`grey`/`gray`). Similar
 * lengths keep every slug roughly the same width in a terminal.
 */
export const SLUG_ADJECTIVES: readonly string[] = [
  "amber", "ample", "basic", "blithe", "bold", "brave", "brief", "bright",
  "brisk", "calm", "civic", "clean", "clear", "clever", "cool", "cosmic",
  "crisp", "curly", "daily", "damp", "dark", "deep", "dense", "dizzy",
  "dusky", "eager", "early", "easy", "empty", "even", "exact", "faint",
  "fancy", "fast", "fine", "firm", "first", "flat", "fleet", "fluid",
  "fond", "frank", "free", "fresh", "full", "fuzzy", "gentle", "giant",
  "glad", "golden", "good", "grand", "green", "gruff", "happy", "hardy",
  "hasty", "hearty", "heavy", "hidden", "high", "honest", "humble", "ideal",
  "inner", "jolly", "joyful", "keen", "kind", "large", "last", "lean",
  "level", "light", "lively", "local", "lofty", "long", "loud", "loyal",
  "lucid", "lucky", "lunar", "magic", "major", "mellow", "mighty", "mild",
  "minor", "misty", "modern", "modest", "muted", "nimble", "noble", "novel",
  "olive", "open", "outer", "placid", "plush", "polar", "prime", "proud",
  "pure", "quick", "quiet", "rapid", "ready", "regal", "rich", "ripe",
  "rocky", "rosy", "round", "royal", "rustic", "safe", "sandy", "sharp",
  "shiny", "silent", "silver", "simple", "sleek", "slim", "small", "smart",
];

/** Same rules as the adjectives, and disjoint from them so a slug never repeats a word. */
export const SLUG_NOUNS: readonly string[] = [
  "acorn", "anchor", "apple", "arbor", "arrow", "aspen", "atlas", "badge",
  "basin", "beacon", "bison", "blade", "bloom", "bolt", "brook", "cabin",
  "cable", "cactus", "candle", "canoe", "canyon", "cedar", "chalk", "cherry",
  "cliff", "clover", "cobalt", "comet", "coral", "cove", "crane", "crater",
  "creek", "crest", "crown", "daisy", "dawn", "delta", "dune", "eagle",
  "ember", "falcon", "fern", "field", "finch", "flame", "flint", "forest",
  "fossil", "garden", "glade", "globe", "grove", "harbor", "haven", "heron",
  "hollow", "ivory", "jetty", "jewel", "kayak", "kettle", "lagoon", "lake",
  "larch", "ledge", "lemon", "lily", "linen", "lotus", "maple", "marble",
  "marsh", "meadow", "mesa", "meteor", "mint", "mist", "moss", "nectar",
  "nest", "oasis", "ocean", "onyx", "opal", "orbit", "orchid", "otter",
  "palm", "pebble", "petal", "pine", "plum", "pond", "poplar", "quartz",
  "quill", "raven", "reef", "ridge", "river", "robin", "rose", "sage",
  "shore", "shrub", "sierra", "slate", "spark", "spruce", "star", "stone",
  "storm", "stream", "summit", "sunset", "swan", "thorn", "timber", "topaz",
  "torch", "tower", "trail", "tulip", "tundra", "valley", "vault", "vine",
];

/** Length of the trailing disambiguating code (`silent-moss-`**`7f2`**). */
export const SLUG_CODE_LENGTH = 3;

/**
 * Bits of randomness in one slug: log2(adjectives) + log2(nouns) + code bits.
 * Exported so callers can reason about the display-vs-secret split in the
 * doc block above instead of eyeballing the word lists.
 */
export const SLUG_ENTROPY_BITS =
  Math.log2(SLUG_ADJECTIVES.length) +
  Math.log2(SLUG_NOUNS.length) +
  SLUG_CODE_LENGTH * Math.log2(CROCKFORD_ALPHABET.length);

/**
 * Shape of a slug: two lowercase words and a Crockford base32 code. The words
 * are not checked against the corpus, so the lists can grow later without
 * invalidating slugs already handed out.
 */
export const SLUG_PATTERN = /^[a-z]+-[a-z]+-[0-9a-hjkmnp-tv-z]{3}$/;

/** True when `value` has the word-word-code shape. Says nothing about liveness. */
export function isSlugFormat(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * Uniform random integer in `[0, bound)` from the platform CSPRNG. Rejection
 * sampling rather than `% bound`, which would bias the low indices of any list
 * whose length does not divide 2^32.
 */
function randomIndex(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  } while (value >= limit);
  return value % bound;
}

function pick(list: readonly string[]): string {
  return list[randomIndex(list.length)]!;
}

/**
 * Generates a fresh display slug, e.g. `silent-moss-7f2`.
 *
 * Unique only probabilistically (see the entropy note at the top of this file):
 * a store that needs uniqueness should go through {@link generateUniqueSlug}.
 */
export function generateSlug(): string {
  let code = "";
  for (let i = 0; i < SLUG_CODE_LENGTH; i++) {
    code += CROCKFORD_ALPHABET[randomIndex(CROCKFORD_ALPHABET.length)]!;
  }
  return `${pick(SLUG_ADJECTIVES)}-${pick(SLUG_NOUNS)}-${code}`;
}

export interface GenerateUniqueSlugOptions {
  /** How many slugs to try before giving up. Defaults to 8. */
  readonly maxAttempts?: number;
}

/**
 * Generates a slug that `isTaken` rejects, retrying on collision.
 *
 * The 2^29 slug space is small enough that a busy registry will hit duplicates,
 * so allocation has to be a check-and-retry loop rather than a single draw.
 * `isTaken` may be async (a KV or D1 lookup); exhausting `maxAttempts` throws
 * rather than returning a slug that is already in use.
 */
export async function generateUniqueSlug(
  isTaken: (slug: string) => boolean | Promise<boolean>,
  options: GenerateUniqueSlugOptions = {}
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 8;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("generateUniqueSlug needs maxAttempts >= 1");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slug = generateSlug();
    if (!(await isTaken(slug))) return slug;
  }
  throw new Error(`Could not allocate an unused slug in ${maxAttempts} attempts`);
}
