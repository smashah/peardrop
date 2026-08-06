import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import Stream from "@hyperswarm/dht-relay/ws";
import { wrapMeteredWebSocket } from "../src/meteredWebSocket.js";

/** Minimal DOM WebSocket shim matching what @hyperswarm/dht-relay/ws Stream expects. */
class MockWebSocket extends EventEmitter {
  binaryType = "arraybuffer";
  readyState = 1;

  send(data: Buffer | ArrayBuffer | string): void {
    this.emit("internal-send", data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  addEventListener(type: string, listener: EventListener): void {
    this.on(type, listener as (...args: unknown[]) => void);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.off(type, listener as (...args: unknown[]) => void);
  }
}

describe("relay metering", () => {
  it("counts outbound bytes on the socket passed to dht-relay Stream", (done) => {
    const mock = new MockWebSocket();
    const { socket, state } = wrapMeteredWebSocket(mock as unknown as import("ws").WebSocket, {
      capBytes: 1024,
      onBytes: () => {},
    });

    const relayStream = new Stream(false, socket);
    relayStream.write(Buffer.from("hello"), () => {
      expect(state.cumulativeBytes).toBe(5);
      done();
    });
  });

  it("counts inbound bytes before dht-relay Stream receives message events", () => {
    const mock = new MockWebSocket();
    const { socket, state } = wrapMeteredWebSocket(mock as unknown as import("ws").WebSocket, {
      capBytes: 1024,
      onBytes: () => {},
    });

    new Stream(false, socket);
    mock.emit("message", { data: Buffer.from("payload") });

    expect(state.cumulativeBytes).toBe(7);
  });

  it("closes the socket when capBytes is exceeded on outbound traffic", (done) => {
    const mock = new MockWebSocket();
    let closed = false;
    mock.close = () => {
      closed = true;
      mock.readyState = 3;
    };

    const { socket } = wrapMeteredWebSocket(mock as unknown as import("ws").WebSocket, {
      capBytes: 4,
      onBytes: () => {},
    });

    const relayStream = new Stream(false, socket);
    relayStream.write(Buffer.from("toolong"), () => {
      expect(closed).toBe(true);
      done();
    });
  });
});
