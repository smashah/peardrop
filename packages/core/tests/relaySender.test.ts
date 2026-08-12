import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const writes: Uint8Array[] = [];
const custodialModes: boolean[] = [];
let rejectNonCustodial = false;
let closeDuringBackpressure = false;
let dhtDestroyCount = 0;
let webSocketCloseCount = 0;
let deliveredFiles = [{ name: "message.txt", bytes: 5, sha256: "abc" }];

vi.mock("@hyperswarm/dht-relay/ws", () => ({ default: class RelayStream {} }));
vi.mock("@hyperswarm/dht-relay", () => ({
  default: class RelayDht {
    private readonly custodial: boolean;
    constructor(_stream: unknown, options: { custodial?: boolean } = {}) {
      this.custodial = options.custodial !== false;
      custodialModes.push(this.custodial);
    }
    connect() {
      const peer = new EventEmitter() as EventEmitter & {
        opened: Promise<boolean>;
        write: (frame: Uint8Array) => boolean;
        destroy: () => void;
      };
      peer.opened = Promise.resolve(true);
      peer.write = (frame) => {
        writes.push(frame);
        const type = frame[4];
        if (closeDuringBackpressure && type === 1) {
          queueMicrotask(() => peer.emit("close"));
          return false;
        }
        if (type === 2 && !(rejectNonCustodial && !this.custodial)) {
          queueMicrotask(() => peer.emit("data", encodeJson(3, { ok: true })));
        }
        if (type === 5 && !(rejectNonCustodial && !this.custodial)) {
          queueMicrotask(() => peer.emit("data", encodeJson(6, { ok: true, files: deliveredFiles })));
        }
        return true;
      };
      peer.destroy = () => undefined;
      return peer;
    }
    destroy() {
      dhtDestroyCount += 1;
    }
  },
}));

const { RelaySenderError, sendRelay } = await import("../src/relay/RelaySender.js");

const encodeJson = (type: number, value: unknown) => {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(payload.length + 5);
  new DataView(frame.buffer).setUint32(0, payload.length + 1, true);
  frame[4] = type;
  frame.set(payload, 5);
  return frame;
};

class MockWebSocket extends EventTarget {
  binaryType = "";
  readonly readyState = 1;
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send() {}
  close() {
    webSocketCloseCount += 1;
  }
}

const descriptor = { slug: "drop", publicKey: "a".repeat(64) };
const file = {
  name: "message.txt",
  size: 5,
  stream: () => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello"));
      controller.close();
    },
  }),
};

const adapters = {
  fetch: async () => new Response(JSON.stringify({
    ticket: "ticket",
    relayUrl: "wss://relay.test",
    billingScheme: "upto",
  })),
  createWebSocket: () => new MockWebSocket(),
  now: (() => {
    let now = 0;
    return () => ++now;
  })(),
};

beforeEach(() => {
  writes.length = 0;
  custodialModes.length = 0;
  rejectNonCustodial = false;
  closeDuringBackpressure = false;
  dhtDestroyCount = 0;
  webSocketCloseCount = 0;
  deliveredFiles = [{ name: "message.txt", bytes: 5, sha256: "abc" }];
});

describe("shared Relay sender", () => {
  it("uses non-custodial Relay PDWP and emits monotonic lifecycle phases", async () => {
    const events: Array<{ phase: string; elapsedMs: number; attempt: number; mode: string }> = [];
    const result = await Effect.runPromise(Effect.scoped(sendRelay({
      descriptor,
      files: [file],
      onEvent: (event) => events.push(event),
    }, adapters)));

    expect(result.mode).toBe("non-custodial");
    expect(custodialModes).toEqual([false]);
    expect(writes.map((frame) => frame[4])).toEqual([1, 2, 4, 5]);
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "ticket-request",
      "socket-open",
      "dht-connect",
      "hello",
      "manifest",
      "accept",
      "bytes",
      "file-end",
      "done",
      "teardown",
    ]));
    expect(events.every((event, index) => index === 0 || event.elapsedMs >= events[index - 1]!.elapsedMs)).toBe(true);
    expect(events.every((event) => event.attempt === 1 && event.mode === "non-custodial")).toBe(true);
  });

  it("falls back only after the non-custodial ACCEPT timeout", async () => {
    rejectNonCustodial = true;
    const events: Array<{ phase: string; reason?: string }> = [];
    const result = await Effect.runPromise(Effect.scoped(sendRelay({
      descriptor,
      files: [file],
      acceptTimeoutMs: 5,
      acceptPollMs: 1,
      onEvent: (event) => events.push(event),
    }, adapters)));

    expect(result.mode).toBe("custodial-fallback");
    expect(custodialModes).toEqual([false, true]);
    expect(events.some((event) => event.phase === "fallback" && event.reason === "accept-timeout")).toBe(true);
  });

  it("fails at ACCEPT without custodial fallback when non-custodial-only is required", async () => {
    rejectNonCustodial = true;
    const exit = await Effect.runPromiseExit(Effect.scoped(sendRelay({
      descriptor,
      files: [file],
      fallback: "none",
      acceptTimeoutMs: 5,
      acceptPollMs: 1,
    }, adapters)));

    expect(custodialModes).toEqual([false]);
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("ACCEPT");
    expect(String(exit)).toContain(RelaySenderError.name);
  });

  it("closes the WebSocket and DHT when descriptor validation fails after connection", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(sendRelay({
      descriptor: { slug: "drop", publicKey: "invalid" },
      files: [file],
      fallback: "none",
    }, adapters)));

    expect(exit._tag).toBe("Failure");
    expect(webSocketCloseCount).toBeGreaterThan(0);
    expect(dhtDestroyCount).toBeGreaterThan(0);
  });

  it("fails a backpressured write when the peer closes instead of hanging", async () => {
    closeDuringBackpressure = true;
    const exit = await Effect.runPromiseExit(Effect.scoped(sendRelay({
      descriptor,
      files: [file],
      fallback: "none",
      acceptTimeoutMs: 50,
    }, adapters)));

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("HELLO");
    expect(webSocketCloseCount).toBeGreaterThan(0);
    expect(dhtDestroyCount).toBeGreaterThan(0);
  });
});
