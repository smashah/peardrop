import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { FrameType, PdwpCodec } from "../src/protocol/pdwp.js";

const harness = vi.hoisted(() => ({ accept: undefined as undefined | ((socket: unknown) => void), destroy: vi.fn(async () => {}) }));
vi.mock("hyperdht", () => ({ default: class {
  createServer(accept: (socket: unknown) => void) {
    harness.accept = accept;
    return { listen: async () => undefined, close: async () => undefined };
  }
  destroy = harness.destroy;
} }));
const { runDhtReceiver } = await import("../src/dht/DhtTransport.js");

describe("receiver DONE acknowledgement (#102)", () => {
  it.each(["acknowledged", "closed", "flush-rejected", "write-rejected"])("settles DONE acknowledgement %s truthfully", async (outcome) => {
    harness.destroy.mockClear();
    let acknowledge!: (flushed: boolean) => void;
    let rejectFlush!: (cause: Error) => void;
    let flushing!: () => void;
    const flushStarted = new Promise<void>((resolve) => { flushing = resolve; });
    const flushed = new Promise<boolean>((resolve, reject) => { acknowledge = resolve; rejectFlush = reject; });
    const peer = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(true).mockImplementationOnce(() => {
        if (outcome === "write-rejected") throw new Error("DONE write rejected");
        return true;
      }),
      pause() {}, resume() {}, destroy: vi.fn(),
      end: vi.fn((done: () => void) => done()),
      flush: vi.fn(() => { flushing(); return flushed; }),
    });
    const receive = Effect.runPromise(Effect.scoped(runDhtReceiver({
      keyPair: { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64), publicKeyHex: "00".repeat(32) },
      sink: { onStart: async () => {}, onChunk: async () => {}, onFileEnd: async () => {}, onDone: async () => [], onError: async () => {} },
      onReady: () => {
        harness.accept!(peer);
        peer.emit("data", Buffer.concat([
          PdwpCodec.encodeJsonFrame(FrameType.HELLO, { v: 1 }),
          PdwpCodec.encodeJsonFrame(FrameType.MANIFEST, { kind: "files", totalBytes: 0, files: [{ name: "empty.txt", bytes: 0, sha256: "abc" }] }),
          PdwpCodec.encodeJsonFrame(FrameType.FILE_END, { fileIndex: 0, sha256: "abc" }),
        ]));
      },
    })));
    if (outcome === "write-rejected") {
      await expect(receive).rejects.toMatchObject({ message: expect.stringContaining("DONE write rejected") });
      expect(peer.flush).not.toHaveBeenCalled();
      expect(peer.end).not.toHaveBeenCalled();
      expect(harness.destroy).toHaveBeenCalledOnce();
      return;
    }
    await Promise.race([flushStarted, receive]);
    expect(peer.flush).toHaveBeenCalledOnce();
    expect(peer.write.mock.calls.length).toBe(2); // ACCEPT, then DONE.
    expect(harness.destroy).not.toHaveBeenCalled();
    expect(peer.destroy).not.toHaveBeenCalled();
    expect(peer.end).not.toHaveBeenCalled();
    if (outcome === "acknowledged") {
      acknowledge(true);
      await receive;
      expect(peer.end).toHaveBeenCalledOnce();
    } else {
      const failed = expect(receive).rejects.toMatchObject({ message: outcome === "closed"
        ? "DHT connection closed before DONE was acknowledged"
        : expect.stringContaining("DONE flush rejected") });
      if (outcome === "closed") acknowledge(false);
      else rejectFlush(new Error("DONE flush rejected"));
      await failed;
      expect(peer.end).not.toHaveBeenCalled();
    }
    expect(peer.destroy).not.toHaveBeenCalled();
    expect(harness.destroy).toHaveBeenCalledOnce();
  });
});
