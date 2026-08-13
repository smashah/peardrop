import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dhtState = vi.hoisted(() => ({
  connectOutcome: "open" as "open" | "error" | "close",
  instances: [] as Array<{ resolveReady(): void }>,
  readyImmediately: false,
}));

vi.mock("hyperdht", async () => {
  const { EventEmitter } = await import("node:events");

  return {
    default: class MockDht {
      private resolveReadyPromise: (() => void) | undefined;

      constructor() {
        dhtState.instances.push(this);
      }

      ready(): Promise<void> {
        if (dhtState.readyImmediately) return Promise.resolve();
        return new Promise((resolve) => {
          this.resolveReadyPromise = resolve;
        });
      }

      resolveReady(): void {
        this.resolveReadyPromise?.();
      }

      connect(): EventEmitter & { destroy(): void } {
        const stream = new EventEmitter() as EventEmitter & { destroy(): void };
        stream.destroy = () => stream.emit("close");
        setImmediate(() => {
          if (dhtState.connectOutcome === "error") stream.emit("error", new Error("unreachable"));
          else stream.emit(dhtState.connectOutcome);
        });
        return stream;
      }

      async destroy(): Promise<void> {}
    },
  };
});

type RelayServer = Awaited<ReturnType<typeof import("../src/index.js")["startRelayServer"]>>;

const servers: RelayServer[] = [];
const ticketSecret = "relay-test-secret";

function signTicket(slug = "test-slug"): string {
  const payload = Buffer.from(JSON.stringify({
    slug,
    publicKey: "ab".repeat(32),
    capBytes: 1024,
    exp: Math.floor(Date.now() / 1000) + 60,
  }));
  const signature = createHmac("sha256", ticketSecret).update(payload).digest();
  return `${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

async function startServer(): Promise<RelayServer> {
  const { startRelayServer } = await import("../src/index.js");
  const server = await startRelayServer();
  servers.push(server);
  return server;
}

function baseUrl(server: RelayServer): string {
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Relay did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function rawUpgrade(server: RelayServer, path: string): Promise<string> {
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Relay did not bind a TCP port");

  return new Promise((resolve, reject) => {
    const socket = connect(address.port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("close", () => resolve(response));
    socket.once("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${address.port}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
  });
}

describe("@peardrop/relay runtime contract", () => {
  beforeEach(() => {
    process.env.PORT = "0";
    process.env.RELAY_TICKET_SECRET = ticketSecret;
    process.env.FLY_REGION = "lhr";
    dhtState.connectOutcome = "open";
    dhtState.instances = [];
    dhtState.readyImmediately = false;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.wss.close();
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error) => error ? reject(error) : resolve())
      );
      await server.dht.destroy();
    }
    vi.resetModules();
    delete process.env.PORT;
    delete process.env.RELAY_TICKET_SECRET;
    delete process.env.FLY_REGION;
  });

  it("exposes /resolve and rejects a missing ticket", async () => {
    const server = await startServer();
    const response = await fetch(`${baseUrl(server)}/resolve`);
    expect(response.status).toBe(401);
  });

  it("reports DHT readiness as JSON health", async () => {
    const server = await startServer();
    const pending = await fetch(`${baseUrl(server)}/healthz`);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toEqual({ ok: false, dhtReady: false });

    dhtState.instances[0]?.resolveReady();
    await new Promise((resolve) => setImmediate(resolve));

    const ready = await fetch(`${baseUrl(server)}/healthz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true, dhtReady: true });
  });

  it("replays /resolve to the ticket's exact requested region", async () => {
    const server = await startServer();
    const response = await fetch(`${baseUrl(server)}/resolve?ticket=${signTicket()}&region=iad`);
    expect(response.status).toBe(200);
    expect(response.headers.get("fly-replay")).toBe("region=iad");
  });

  it.each([
    ["open", 200, true],
    ["error", 503, false],
  ] as const)("maps peer resolution outcome %s to HTTP %s", async (outcome, status, reachable) => {
    dhtState.readyImmediately = true;
    dhtState.connectOutcome = outcome;
    const server = await startServer();
    await new Promise((resolve) => setImmediate(resolve));

    const response = await fetch(`${baseUrl(server)}/resolve?ticket=${signTicket()}`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ reachable, region: "lhr" });
  });

  it("rejects WebSocket upgrades until the DHT is ready", async () => {
    const server = await startServer();
    const response = await rawUpgrade(server, `/?ticket=${signTicket()}`);
    expect(response).toMatch(/^HTTP\/1\.1 503 Service Unavailable/);
  });

  it("replays a WebSocket region before consuming its ticket", async () => {
    dhtState.readyImmediately = true;
    const server = await startServer();
    await new Promise((resolve) => setImmediate(resolve));
    const path = `/?ticket=${signTicket()}&region=iad`;

    const first = await rawUpgrade(server, path);
    const second = await rawUpgrade(server, path);

    expect(first).toContain("fly-replay: region=iad");
    expect(second).toContain("fly-replay: region=iad");
  });
});
