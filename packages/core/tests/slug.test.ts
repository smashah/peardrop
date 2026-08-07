import { describe, expect, it } from "vitest";
import {
  SLUG_ADJECTIVES,
  SLUG_CODE_LENGTH,
  SLUG_ENTROPY_BITS,
  SLUG_NOUNS,
  SLUG_PATTERN,
  generateSlug,
  generateUniqueSlug,
  isSlugFormat,
} from "../src/tunnel/slug.js";

// Crockford base32: digits plus lowercase letters minus i, l, o, u.
const CODE_CHARS = /^[0-9a-hjkmnp-tv-z]+$/;

describe("word-based drop slugs (#16)", () => {
  describe("word corpus hygiene", () => {
    it("keeps both lists power-of-two sized so the entropy claim is exact", () => {
      expect(SLUG_ADJECTIVES).toHaveLength(128);
      expect(SLUG_NOUNS).toHaveLength(128);
      // 7 bits + 7 bits + 3 x 5 bits = 29 bits ~ 5.4e8 slugs.
      expect(SLUG_ENTROPY_BITS).toBe(29);
    });

    it("has no duplicates within or across the lists", () => {
      expect(new Set(SLUG_ADJECTIVES).size).toBe(SLUG_ADJECTIVES.length);
      expect(new Set(SLUG_NOUNS).size).toBe(SLUG_NOUNS.length);
      const overlap = SLUG_ADJECTIVES.filter((word) => SLUG_NOUNS.includes(word));
      expect(overlap).toEqual([]);
    });

    it("keeps every word short, lowercase and similar in length", () => {
      for (const word of [...SLUG_ADJECTIVES, ...SLUG_NOUNS]) {
        expect(word).toMatch(/^[a-z]+$/);
        expect(word.length).toBeGreaterThanOrEqual(4);
        expect(word.length).toBeLessThanOrEqual(6);
      }
    });
  });

  describe("generateSlug", () => {
    it("emits adjective-noun-code in the advertised shape", () => {
      for (let i = 0; i < 200; i++) {
        const slug = generateSlug();
        expect(slug).toMatch(SLUG_PATTERN);
        expect(isSlugFormat(slug)).toBe(true);

        const [adjective, noun, code] = slug.split("-");
        expect(SLUG_ADJECTIVES).toContain(adjective);
        expect(SLUG_NOUNS).toContain(noun);
        expect(code).toHaveLength(SLUG_CODE_LENGTH);
        expect(code).toMatch(CODE_CHARS);
      }
    });

    it("stays short enough to read aloud", () => {
      // Longest possible slug: 6-letter adjective + 6-letter noun + 3-char code.
      for (let i = 0; i < 200; i++) {
        expect(generateSlug().length).toBeLessThanOrEqual(17);
      }
    });

    it("draws from the whole corpus rather than a fixed corner of it", () => {
      const adjectives = new Set<string>();
      const nouns = new Set<string>();
      const codeChars = new Set<string>();
      for (let i = 0; i < 4000; i++) {
        const [adjective, noun, code] = generateSlug().split("-");
        adjectives.add(adjective!);
        nouns.add(noun!);
        for (const char of code!) codeChars.add(char);
      }
      // 4000 draws over 128 words leaves a vanishing chance of missing many.
      expect(adjectives.size).toBeGreaterThan(120);
      expect(nouns.size).toBeGreaterThan(120);
      expect(codeChars.size).toBe(32);
    });

    it("practically never repeats itself", () => {
      const slugs = new Set<string>();
      for (let i = 0; i < 1000; i++) slugs.add(generateSlug());
      // 1000 draws from ~5.4e8 slugs: one collision is a ~1-in-1000 event, two
      // is ~1-in-2.5-million, so this bound is tight without being flaky.
      expect(slugs.size).toBeGreaterThanOrEqual(999);
    });
  });

  describe("isSlugFormat", () => {
    it("accepts the shape without demanding corpus membership", () => {
      // Words the corpus may not carry yet must still validate, so growing the
      // lists later cannot invalidate slugs already handed out.
      expect(isSlugFormat("silent-moss-7f2")).toBe(true);
      expect(isSlugFormat("unlisted-wordhere-abc")).toBe(true);
    });

    it("rejects old base32 slugs, ambiguous code characters and stray segments", () => {
      expect(isSlugFormat("6xk9r2wq0f8m3ptn5jd7vhb4zc")).toBe(false);
      expect(isSlugFormat("silent-moss-7i2")).toBe(false); // `i` is not Crockford
      expect(isSlugFormat("silent-moss-7f")).toBe(false);
      expect(isSlugFormat("silent-moss-7f22")).toBe(false);
      expect(isSlugFormat("silent-moss")).toBe(false);
      expect(isSlugFormat("silent-moss-7f2-extra")).toBe(false);
      expect(isSlugFormat("Silent-Moss-7F2")).toBe(false);
      expect(isSlugFormat("")).toBe(false);
    });
  });

  describe("generateUniqueSlug", () => {
    it("retries past taken slugs and returns the first free one", async () => {
      const attempted: string[] = [];
      const slug = await generateUniqueSlug((candidate) => {
        attempted.push(candidate);
        return attempted.length < 3;
      });
      expect(attempted).toHaveLength(3);
      expect(slug).toBe(attempted[2]);
      expect(isSlugFormat(slug)).toBe(true);
    });

    it("awaits an async collision check", async () => {
      const slug = await generateUniqueSlug(async (candidate) => candidate.endsWith("zzz"));
      expect(isSlugFormat(slug)).toBe(true);
    });

    it("throws rather than handing back a slug that is already taken", async () => {
      let calls = 0;
      await expect(
        generateUniqueSlug(
          () => {
            calls++;
            return true;
          },
          { maxAttempts: 4 }
        )
      ).rejects.toThrow(/4 attempts/);
      expect(calls).toBe(4);
    });

    it("rejects a nonsensical attempt budget", async () => {
      await expect(generateUniqueSlug(() => false, { maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
    });
  });
});
