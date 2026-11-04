import { timingSafeEqual } from "node:crypto";
import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { IngestorClient } from "../ingestor/ingestor-client";
import type { QueueClient } from "../queue/queue-client";
import type { WorkerRuntime } from "./worker-runtime";

export type HealthQueue = Pick<QueueClient, "getMetrics" | "ping">;
export type HealthIngestor = Pick<IngestorClient, "ping">;

export type HealthServerOptions = {
  host: string;
  port: number;
  metricsToken: string | null;
  runtime: WorkerRuntime;
  queue: HealthQueue;
  ingestor: HealthIngestor;
};

export type HealthServer = {
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
};

function writeJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function isAuthorized(request: IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  let server: http.Server | null = null;
  let boundPort = options.port;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if ((request.method ?? "GET") !== "GET") {
      writeJson(response, 405, { status: "method_not_allowed" });
      return;
    }

    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (path === "/readyz") {
      if (!isAuthorized(request, options.metricsToken)) {
        writeJson(response, 401, { status: "unauthorized" });
        return;
      }
      const [queuePing, ingestorPing] = await Promise.allSettled([
        options.queue.ping(),
        options.ingestor.ping(),
      ]);
      const dbReady =
        queuePing.status === "fulfilled" && ingestorPing.status === "fulfilled";
      const health = options.runtime.getHealth();
      const ready = dbReady && health.status === "ok";
      writeJson(response, ready ? 200 : 503, {
        ...health,
        status: ready ? "ready" : "not_ready",
        dbReady,
      });
      return;
    }

    if (path === "/metrics") {
      if (!isAuthorized(request, options.metricsToken)) {
        writeJson(response, 401, { status: "unauthorized" });
        return;
      }

      let queueMetrics: unknown = null;
      let queueMetricsError = false;
      try {
        queueMetrics = await options.queue.getMetrics();
      } catch {
        queueMetricsError = true;
      }

      writeJson(response, 200, {
        ...options.runtime.getMetrics(),
        queue: queueMetrics,
        queueMetricsError,
      });
      return;
    }

    writeJson(response, 404, { status: "not_found" });
  };

  return {
    async start() {
      if (server) return { host: options.host, port: boundPort };

      const created = http.createServer((request, response) => {
        void handle(request, response).catch(() => {
          if (!response.headersSent) {
            writeJson(response, 500, { status: "error" });
          } else {
            response.end();
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          created.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          created.removeListener("error", onError);
          resolve();
        };
        created.once("error", onError);
        created.once("listening", onListening);
        created.listen(options.port, options.host);
      });

      const address = created.address();
      boundPort =
        address && typeof address === "object" ? address.port : options.port;
      server = created;
      return { host: options.host, port: boundPort };
    },

    async close() {
      const current = server;
      if (!current) return;
      server = null;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
    },
  };
}
