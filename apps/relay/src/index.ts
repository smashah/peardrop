import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import DHT from "hyperdht";
// dht-relay's runtime shape is CJS: module.exports = Node (the client CLASS)
// with the relay-side entry attached as module.exports.relay. Its .d.ts only
// declares the default export, so a named import fails typecheck — and a bare
// default import resolves to the class, which when called as a function threw
// "Class constructor Node cannot be invoked without 'new'" on every WS
// connection, crashing the whole process mid-upgrade (2026-08-11 incident).
import DhtRelayDefault from "@hyperswarm/dht-relay";
const relay = (DhtRelayDefault as unknown as {
  relay: (dht: unknown, stream: unknown) => void;
}).relay;
if (typeof relay !== "function") {
  // Fail at boot, not per-connection: a silent API drift here previously took
  // down the process on the first real user connection instead of on deploy.
  throw new Error("@hyperswarm/dht-relay no longer exposes .relay on its default export — API drift, fix the interop before serving");
}
import Stream from "@hyperswarm/dht-relay/ws";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  ExternalServiceError,
  retryTransient,
  verifyRelayTicketSync,
  type RelayTicketClaims,
} from "@peardrop/core/node";
import { wrapMeteredWebSocket } from "./meteredWebSocket.js";

export interface RelayServer {
  readonly httpServer: ReturnType<typeof createServer>;
  readonly wss: WebSocketServer;
  readonly dht: {
    destroy(): Promise<void>;
  };
}

const PORT = parseInt(process.env.PORT || "8080", 10);
const WORKER_URL = (process.env.WORKER_URL || "https://peardrop.fyi").replace(/\/$/, "");
// Fly auto-injects both — FLY_ALLOC_ID identifies this specific machine
// instance, while FLY_REGION identifies its region.
const MACHINE_ID = `${process.env.FLY_REGION || "?"}:${(process.env.FLY_ALLOC_ID || "local").slice(0, 8)}`;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`${name} must be set`);
  }
  return val;
}

const activeSessionsPerSlug = new Map<string, number>();
const activeSessionsPerIp = new Map<string, number>();
const usedTickets = new Map<string, number>();
const MAX_ACTIVE_SESSIONS_PER_SLUG = 4;
const MAX_ACTIVE_SESSIONS_PER_IP = 16;
const MAX_TICKET_CAP_BYTES = 2 * 1024 * 1024 * 1024;

const startIdleTimeout = (socket: WebSocket) =>
  Effect.runFork(
    Effect.sleep(Duration.seconds(60)).pipe(
      Effect.andThen(Effect.sync(() => socket.close(1000, "Idle timeout")))
    )
  );

const reportUsageToWorker = (slug: string, bytes: number, final = false) => {
  const attempt = Effect.tryPromise({
    try: async () => {
      const token = requireEnv("RELAY_API_TOKEN");
      const response = await fetch(`${WORKER_URL}/api/usage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ slug, bytes, final }),
      });
      if (!response.ok) {
        const error = new Error(`usage reporter returned HTTP ${response.status}`);
        Reflect.set(error, "status", response.status);
        throw error;
      }
    },
    catch: (cause) => {
      const status =
        typeof cause === "object" && cause !== null && typeof Reflect.get(cause, "status") === "number"
          ? Number(Reflect.get(cause, "status"))
          : undefined;
      return new ExternalServiceError({
        cause,
        operation: final ? "final usage report" : "usage checkpoint",
        retryable: status === undefined || status === 408 || status === 429 || status >= 500,
        service: "peardrop-worker",
      });
    },
  });
  return retryTransient(attempt, { baseDelay: Duration.millis(250), maxRetries: final ? 4 : 2 });
};

const runUsageReport = (program: ReturnType<typeof reportUsageToWorker>): void => {
  Effect.runFork(
    program.pipe(Effect.match({
      onFailure: (error) => {
        process.stderr.write(`Relay usage reporting failed (${error.operation}): ${String(error.cause)}\n`);
      },
      onSuccess: () => undefined,
    }))
  );
};

export async function startRelayServer(): Promise<RelayServer> {
  const ticketSecret = requireEnv("RELAY_TICKET_SECRET");
  const dht = new DHT();

  let dhtReady = false;
  dht.ready().then(
    () => {
      dhtReady = true;
      process.stdout.write("[dht] socket bound and bootstrap complete\n");
    },
    (error: unknown) => {
      process.stderr.write(
        `FATAL: DHT bind/bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  );

  const dhtConnect = dht.connect.bind(dht);
  dht.connect = ((remotePublicKey: Buffer, options?: unknown) => {
    const peerHex = remotePublicKey.toString("hex");
    process.stderr.write(`[dht.connect] attempting peer=${peerHex}\n`);
    const stream = dhtConnect(remotePublicKey, options);
    stream.once("open", () => process.stderr.write(`[dht.connect] OPEN peer=${peerHex}\n`));
    stream.once("error", (error: Error) =>
      process.stderr.write(`[dht.connect] ERROR peer=${peerHex} :: ${error.message}\n`)
    );
    stream.once("close", () => process.stderr.write(`[dht.connect] CLOSE peer=${peerHex}\n`));
    return stream;
  }) as typeof dht.connect;

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (reqUrl.pathname === "/healthz") {
        res.writeHead(dhtReady ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: dhtReady, dhtReady }));
        return;
      }

      if (reqUrl.pathname === "/resolve") {
        const ticketParam = reqUrl.searchParams.get("ticket");
        if (!ticketParam) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        try {
          verifyRelayTicketSync(ticketParam, ticketSecret);
        } catch {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        const requestedRegion = reqUrl.searchParams.get("region");
        if (requestedRegion && requestedRegion !== process.env.FLY_REGION) {
          res.writeHead(200, { "fly-replay": `region=${requestedRegion}` });
          res.end();
          return;
        }

        res.writeHead(dhtReady ? 200 : 503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ reachable: dhtReady, region: process.env.FLY_REGION ?? "unknown" }));
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    })().catch((error: unknown) => {
      process.stderr.write(
        `[resolve] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
      );
      if (!res.headersSent) res.writeHead(500, { "Cache-Control": "no-store" });
      res.end("Internal Server Error");
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!dhtReady) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    const reqUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const ticketParam = reqUrl.searchParams.get("ticket");
    const regionParam = reqUrl.searchParams.get("region");
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [ticket, expiresAt] of usedTickets) {
      if (expiresAt < nowSeconds) usedTickets.delete(ticket);
    }

    if (!ticketParam || usedTickets.has(ticketParam)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let claims: RelayTicketClaims;
    try {
      claims = verifyRelayTicketSync(ticketParam, ticketSecret);
    } catch (cause) {
      process.stderr.write(`Rejected relay ticket: ${String(cause)}\n`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (regionParam && regionParam !== process.env.FLY_REGION) {
      process.stderr.write(
        `[relay] replaying to region=${regionParam} (this machine is ${process.env.FLY_REGION ?? "unknown"})\n`
      );
      socket.write(`HTTP/1.1 200 OK\r\nfly-replay: region=${regionParam}\r\n\r\n`);
      socket.destroy();
      return;
    }

    const { slug } = claims;
    if (claims.capBytes > MAX_TICKET_CAP_BYTES) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const currentSessions = activeSessionsPerSlug.get(slug) || 0;
    const currentIpSessions = activeSessionsPerIp.get(remoteAddress) || 0;
    if (currentSessions >= MAX_ACTIVE_SESSIONS_PER_SLUG || currentIpSessions >= MAX_ACTIVE_SESSIONS_PER_IP) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    usedTickets.set(ticketParam, claims.exp);
    // Tag each accepted session with the machine that owns its process-local
    // replay and rate-limit state so fleet routing problems remain diagnosable.
    process.stdout.write(`[accept] slug=${claims.slug} machine=${MACHINE_ID}\n`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, claims, remoteAddress);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, claims: RelayTicketClaims, remoteAddress: string) => {
    const { slug, capBytes } = claims;
    process.stdout.write(`[connection] slug=${slug} machine=${MACHINE_ID}\n`);
    activeSessionsPerSlug.set(slug, (activeSessionsPerSlug.get(slug) || 0) + 1);
    activeSessionsPerIp.set(remoteAddress, (activeSessionsPerIp.get(remoteAddress) || 0) + 1);

    let lastReportedBytes = 0;
    const REPORT_INTERVAL = 25 * 1024 * 1024;
    let idleTimeout = startIdleTimeout(ws);

    const resetIdleTimeout = () => {
      Effect.runFork(Fiber.interrupt(idleTimeout));
      idleTimeout = startIdleTimeout(ws);
    };

    const { socket: meteredSocket, state } = wrapMeteredWebSocket(ws, {
      capBytes,
      onBytes: (bytes) => {
        resetIdleTimeout();
        if (bytes - lastReportedBytes >= REPORT_INTERVAL) {
          lastReportedBytes = bytes;
          runUsageReport(reportUsageToWorker(slug, bytes, false));
        }
      },
    });

    const socketStream = new Stream(false, meteredSocket);
    relay(dht, socketStream);

    ws.on("error", (error: Error) => {
      process.stderr.write(`[ws] error slug=${slug} :: ${error.message}\n`);
    });

    ws.on("close", (code: number) => {
      process.stderr.write(`[ws] close slug=${slug} code=${code}\n`);
      Effect.runFork(Fiber.interrupt(idleTimeout));
      const remaining = (activeSessionsPerSlug.get(slug) || 1) - 1;
      if (remaining <= 0) activeSessionsPerSlug.delete(slug);
      else activeSessionsPerSlug.set(slug, remaining);
      const remainingForIp = (activeSessionsPerIp.get(remoteAddress) || 1) - 1;
      if (remainingForIp <= 0) activeSessionsPerIp.delete(remoteAddress);
      else activeSessionsPerIp.set(remoteAddress, remainingForIp);

      runUsageReport(reportUsageToWorker(slug, state.cumulativeBytes, true));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(PORT, () => {
      httpServer.removeListener("error", reject);
      process.stdout.write(`PearDrop Relay server listening on port ${PORT}\n`);
      resolve();
    });
  });

  return { httpServer, wss, dht };
}

if (process.env.NODE_ENV !== "test") {
  startRelayServer().catch((error: unknown) => {
    process.stderr.write(
      `FATAL: relay failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
