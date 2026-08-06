import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import DHT from "hyperdht";
import relay from "@hyperswarm/dht-relay";
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

export function startRelayServer(): RelayServer {
  const ticketSecret = requireEnv("RELAY_TICKET_SECRET");
  const dht = new DHT();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    const reqUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const ticketParam = reqUrl.searchParams.get("ticket");
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
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, claims, remoteAddress);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, claims: RelayTicketClaims, remoteAddress: string) => {
    const { slug, capBytes } = claims;
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

    ws.on("close", () => {
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

  httpServer.listen(PORT, () => {
    process.stdout.write(`PearDrop Relay server listening on port ${PORT}\n`);
  });

  return { httpServer, wss, dht };
}

if (process.env.NODE_ENV !== "test") {
  startRelayServer();
}
