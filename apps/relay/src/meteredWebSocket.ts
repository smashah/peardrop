import type { WebSocketLike, WebSocketLikeEvent, WebSocketLikeListener } from "@hyperswarm/dht-relay/ws";
import type { WebSocket } from "ws";

export interface MeteredSocketOptions {
  readonly capBytes: number;
  readonly onBytes: (cumulativeBytes: number) => void;
}

export interface MeteredSocketState {
  readonly cumulativeBytes: number;
}

const byteLength = (data: unknown): number => {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((acc: number, part) => acc + byteLength(part), 0);
  return 0;
};

const messageData = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "data" in value
    ? Reflect.get(value, "data")
    : value;

/**
 * Facade over a `ws` WebSocket matching the surface @hyperswarm/dht-relay/ws
 * Stream consumes (binaryType, readyState, send, close, addEventListener),
 * metering every inbound and outbound frame against the ticket cap. Frames
 * that would exceed the cap are rejected with close(4402) instead of forwarded.
 */
export function wrapMeteredWebSocket(
  socket: WebSocket,
  options: MeteredSocketOptions
): { socket: WebSocketLike; state: MeteredSocketState } {
  let cumulativeBytes = 0;
  let capped = false;

  const state: MeteredSocketState = {
    get cumulativeBytes() {
      return cumulativeBytes;
    },
  };

  const exhaustAllowance = (): void => {
    capped = true;
    socket.close(4402, "Relay allowance exhausted");
  };

  const recordBytes = (bytes: number): void => {
    cumulativeBytes += bytes;
    options.onBytes(cumulativeBytes);
    if (cumulativeBytes > options.capBytes) exhaustAllowance();
  };

  const listeners = new Map<WebSocketLikeListener, (...args: readonly unknown[]) => void>();

  const facade: WebSocketLike = {
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(value: string) {
      socket.binaryType = value as WebSocket["binaryType"];
    },
    get readyState() {
      return socket.readyState;
    },
    send(data: Buffer | ArrayBuffer | string) {
      if (capped) return;
      const size = byteLength(data);
      if (cumulativeBytes + size > options.capBytes) {
        exhaustAllowance();
        return;
      }
      recordBytes(size);
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    addEventListener(type: "open" | "close" | "error" | "message", listener: WebSocketLikeListener) {
      const wrapped = (...args: readonly unknown[]) => {
        const raw = args[0];
        if (type !== "message") {
          listener({ type, data: raw, target: facade });
          return;
        }

        const data = messageData(raw);
        if (capped) return;
        recordBytes(byteLength(data));
        if (!capped) listener({ type, data, target: facade });
      };
      listeners.set(listener, wrapped);
      socket.on(type, wrapped);
    },
    removeEventListener(type: "open" | "close" | "error" | "message", listener: WebSocketLikeListener) {
      const wrapped = listeners.get(listener);
      if (wrapped) {
        socket.off(type, wrapped);
        listeners.delete(listener);
      }
    },
  };

  return { socket: facade, state };
}
