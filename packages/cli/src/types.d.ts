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
