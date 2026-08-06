declare module "hyperdht" {
  import type { EventEmitter } from "node:events";
  import type { Duplex } from "node:stream";

  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface Server extends EventEmitter {
    listen(keyPair: KeyPair): Promise<void>;
    close(): Promise<void>;
  }

  interface DHTInstance extends EventEmitter {
    createServer(onConnection: (socket: Duplex) => void): Server;
    connect(remotePublicKey: Buffer): Duplex;
    destroy(): Promise<void>;
  }

  interface DHTConstructor {
    new (): DHTInstance;
    keyPair(seed?: Buffer): KeyPair;
  }

  const DHT: DHTConstructor;
  export default DHT;
}

declare module "@hyperswarm/dht-relay" {
  import type { Duplex } from "streamx";
  import type { DHTInstance } from "hyperdht";

  const relay: (dht: DHTInstance, stream: Duplex) => void;
  export default relay;
}

declare module "@hyperswarm/dht-relay/ws" {
  import type { Duplex } from "streamx";

  export interface WebSocketLikeEvent {
    readonly type: string;
    readonly data?: unknown;
    readonly target?: unknown;
  }

  export type WebSocketLikeListener = (event: WebSocketLikeEvent) => void;

  export interface WebSocketLike {
    binaryType: string;
    readonly readyState: number;
    send(data: Buffer | ArrayBuffer | string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "open" | "close" | "error" | "message", listener: WebSocketLikeListener): void;
    removeEventListener(type: "open" | "close" | "error" | "message", listener: WebSocketLikeListener): void;
  }

  class Stream extends Duplex {
    constructor(isInitiator: boolean, socket: WebSocketLike);
  }

  export default Stream;
}
