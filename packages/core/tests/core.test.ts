import { describe, expect, it } from "vitest";
import { expect as effectExpect, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { calculateRelayFee, calculateMaxCapAuthorization } from "../src/payments/RelayBilling.js";
import { MAX_PDWP_FRAME_BYTES, PdwpCodec, PdwpFrameParser, FrameType } from "../src/protocol/pdwp.js";
import { generateSlug, computeOwnerToken, generateFingerprint } from "../src/tunnel/crypto.js";
import { signRelayTicket, verifyRelayTicket } from "../src/tickets/RelayTicket.js";

describe("@peardrop/core (platform-neutral)", () => {
  describe("RelayBilling pricing schedule", () => {
    it("calculates exact monotonic pricing per PRD spec", () => {
      expect(calculateRelayFee(0)).toBe(0);
      expect(calculateRelayFee(100)).toBe(0.01);
      expect(calculateRelayFee(50 * 1024 * 1024)).toBe(0.01);
      expect(calculateRelayFee(50 * 1024 * 1024 + 1)).toBe(0.02);
      expect(calculateRelayFee(500 * 1024 * 1024)).toBe(0.02);
      expect(calculateRelayFee(1.5 * 1e9)).toBe(0.045);
      expect(calculateMaxCapAuthorization(2)).toBe(0.06);
    });
  });

  describe("PDWP/1 protocol framing", () => {
    effectIt.effect("keeps receiver completion gated on a decoded DONE frame", () =>
      Effect.sync(() => {
        const parser = new PdwpFrameParser();
        const accept = parser.append(PdwpCodec.encodeJsonFrame(FrameType.ACCEPT, { ok: true }));
        effectExpect(accept.some((frame) => frame.type === FrameType.DONE)).toBe(false);
        const done = parser.append(PdwpCodec.encodeJsonFrame(FrameType.DONE, { ok: true, files: [] }));
        effectExpect(done.some((frame) => frame.type === FrameType.DONE)).toBe(true);
      })
    );
    it("encodes and decodes frames correctly", () => {
      const parser = new PdwpFrameParser();
      const helloBuf = PdwpCodec.encodeJsonFrame(FrameType.HELLO, { v: 1, pin: "123456" });

      const frames = parser.append(helloBuf);
      expect(frames).toHaveLength(1);
      expect(frames[0]?.type).toBe(FrameType.HELLO);
      expect(frames[0]?.payload).toEqual({ v: 1, pin: "123456" });
    });

    it("rejects oversized and malformed frame lengths before buffering them", () => {
      const parser = new PdwpFrameParser();
      const oversized = Buffer.alloc(5);
      oversized.writeUInt32LE(MAX_PDWP_FRAME_BYTES + 1, 0);
      oversized.writeUInt8(FrameType.FILE, 4);
      expect(() => parser.append(oversized)).toThrow(/length/i);
      expect(() => PdwpCodec.encodeFrame(FrameType.FILE, Buffer.alloc(MAX_PDWP_FRAME_BYTES))).toThrow(/maximum/i);
    });
  });

  describe("Tunnel crypto helpers", () => {
    it("generates 26-char Crockford base32 slugs", () => {
      const slug = generateSlug();
      expect(slug).toHaveLength(26);
      expect(slug).toMatch(/^[0-9a-z]+$/i);
    });

    it("computes deterministic owner tokens and fingerprints", async () => {
      const tok1 = await computeOwnerToken("test-slug", "pepper-secret");
      const tok2 = await computeOwnerToken("test-slug", "pepper-secret");
      expect(tok1).toBe(tok2);

      const fp = generateFingerprint("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
      expect(fp).toHaveLength(8);
    });
  });

  describe("Relay ticket signing", () => {
    it("signs and verifies tickets with expiry enforcement", async () => {
      const claims = {
        slug: "testslug",
        publicKey: "abcd",
        capBytes: 1024,
        exp: Math.floor(Date.now() / 1000) + 60,
      };
      const ticket = await signRelayTicket(claims, "test-secret");
      const verified = await verifyRelayTicket(ticket, "test-secret");
      expect(verified.slug).toBe("testslug");
    });

    it("rejects expired tickets", async () => {
      const claims = {
        slug: "testslug",
        publicKey: "abcd",
        capBytes: 1024,
        exp: Math.floor(Date.now() / 1000) - 10,
      };
      const ticket = await signRelayTicket(claims, "test-secret");
      await expect(verifyRelayTicket(ticket, "test-secret")).rejects.toThrow(/expired/i);
    });
  });
});
