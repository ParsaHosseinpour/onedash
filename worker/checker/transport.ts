import net from "node:net";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { Agent } from "undici";
import type { ResolvedAddress } from "./destination";
import { CheckTimeoutError, TransportError } from "./errors";
import { CHECKER_USER_AGENT } from "./limits";

export type CheckerMethod = "GET" | "HEAD";

export type HttpRequestInput = {
  url: URL;
  method: CheckerMethod;
  /** The validated address the socket must connect to. */
  pinnedAddress: ResolvedAddress;
  /** Original hostname for TLS SNI and certificate verification, or null for an IP literal. */
  tlsServername: string | null;
  timeoutMs: number;
  connectTimeoutMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
};

export type HttpTransportResponse = {
  statusCode: number;
  location: string | null;
  contentLength: number | null;
  bytesRead: number;
  timings: {
    connectMs: number | null;
    tlsMs: number | null;
    ttfbMs: number;
  };
};

export interface HttpTransport {
  request(input: HttpRequestInput): Promise<HttpTransportResponse>;
}

type ConnectorOptions = {
  hostname: string;
  host?: string;
  protocol: string;
  port: string;
  servername?: string;
  localAddress?: string | null;
  socketPath?: string | null;
  httpSocket?: net.Socket;
};

type ConnectorCallback = (
  ...args: [null, net.Socket | tls.TLSSocket] | [Error, null]
) => void;

type Connector = (options: ConnectorOptions, callback: ConnectorCallback) => void;

class ConnectTimeoutError extends Error {
  readonly code = "CHECKER_CONNECT_TIMEOUT";

  constructor() {
    super("connect timeout");
    this.name = "ConnectTimeoutError";
  }
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value));
}

/**
 * A connector that ignores the URL hostname for name resolution and always
 * dials the pinned address. TLS still receives the original hostname as SNI
 * and as the certificate-verification name.
 */
function createPinnedConnector(input: {
  address: string;
  family: 4 | 6;
  servername: string | null;
  connectTimeoutMs: number;
  onConnect: (ms: number) => void;
  onTls: (ms: number) => void;
}): Connector {
  return (options, callback) => {
    if (options.protocol !== "http:" && options.protocol !== "https:") {
      callback(new Error("unsupported protocol"), null);
      return;
    }

    const isTls = options.protocol === "https:";
    const port = Number(options.port) || (isTls ? 443 : 80);
    const started = performance.now();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let socket: net.Socket | tls.TLSSocket | undefined;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const succeed = (connected: net.Socket | tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      clearTimer();
      callback(null, connected);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (socket && !socket.destroyed) socket.destroy();
      callback(error, null);
    };

    const baseOptions = {
      host: input.address,
      port,
      family: input.family,
      autoSelectFamily: false,
      localAddress: options.localAddress ?? undefined,
    };

    try {
      if (isTls) {
        socket = tls.connect({
          ...baseOptions,
          servername: input.servername ?? undefined,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ALPNProtocols: ["http/1.1"],
        });

        socket.once("connect", () => {
          input.onConnect(performance.now() - started);
        });
        socket.once("secureConnect", () => {
          input.onTls(performance.now() - started);
          succeed(socket as tls.TLSSocket);
        });
      } else {
        socket = net.connect(baseOptions);
        socket.once("connect", () => {
          input.onConnect(performance.now() - started);
          succeed(socket as net.Socket);
        });
      }

      if (!socket) {
        fail(new Error("socket setup failed"));
        return;
      }

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 60_000);
      timer = setTimeout(
        () => fail(new ConnectTimeoutError()),
        input.connectTimeoutMs,
      );
      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) fail(new Error("socket closed before connect"));
      });
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error("socket setup failed"),
      );
    }
  };
}

function firstHeader(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseContentLength(
  value: string | string[] | undefined,
): number | null {
  const raw = firstHeader(value);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function collectErrorCodes(error: unknown, depth = 0): string[] {
  if (depth > 3 || typeof error !== "object" || error === null) return [];

  const codes: string[] = [];
  if ("code" in error && typeof error.code === "string") {
    codes.push(error.code);
  }
  if ("name" in error && typeof error.name === "string") {
    codes.push(error.name);
  }
  if ("cause" in error && error.cause) {
    codes.push(...collectErrorCodes(error.cause, depth + 1));
  }
  return codes;
}

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_REJECTED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EPROTO",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const TIMEOUT_CODES = new Set([
  "CHECKER_CONNECT_TIMEOUT",
  "ETIMEDOUT",
  "TimeoutError",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const CONNECTION_FAILURE_CODES = new Set([
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CLOSED",
  "UND_ERR_SOCKET",
]);

function isTlsCode(code: string): boolean {
  return (
    TLS_CODES.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("ERR_OSSL_")
  );
}

function classifyTransportError(
  error: unknown,
  signal: AbortSignal,
): TransportError {
  if (error instanceof TransportError) return error;

  if (signal.aborted) {
    if (signal.reason instanceof CheckTimeoutError) {
      return new TransportError("timeout");
    }
    return new TransportError("aborted");
  }

  const codes = collectErrorCodes(error);

  if (codes.some((code) => TIMEOUT_CODES.has(code))) {
    return new TransportError("timeout");
  }
  if (codes.includes("UND_ERR_RES_EXCEEDED_MAX_SIZE")) {
    return new TransportError("response_too_large");
  }
  if (codes.includes("ECONNREFUSED")) {
    return new TransportError("connection_refused");
  }
  if (codes.some(isTlsCode)) {
    return new TransportError("tls_error");
  }
  if (
    codes.includes("UND_ERR_ABORTED") ||
    codes.includes("ABORT_ERR") ||
    codes.includes("AbortError")
  ) {
    return new TransportError("aborted");
  }
  if (codes.some((code) => CONNECTION_FAILURE_CODES.has(code))) {
    return new TransportError("connection_failure");
  }
  if (codes.some((code) => code.startsWith("UND_ERR_"))) {
    return new TransportError("internal_error");
  }

  return new TransportError("connection_failure");
}

/**
 * Creates the production HTTP transport. Every request gets a fresh Agent and
 * a fresh pinned connector, so sockets and TLS sessions cannot leak across
 * checks or destinations.
 */
export function createUndiciTransport(): HttpTransport {
  return {
    async request(input) {
      const timings: HttpTransportResponse["timings"] = {
        connectMs: null,
        tlsMs: null,
        ttfbMs: 0,
      };

      const connector = createPinnedConnector({
        address: input.pinnedAddress.address,
        family: input.pinnedAddress.family,
        servername: input.tlsServername,
        connectTimeoutMs: input.connectTimeoutMs,
        onConnect: (ms) => {
          timings.connectMs = roundMs(ms);
        },
        onTls: (ms) => {
          timings.tlsMs = roundMs(ms);
        },
      });

      const agent = new Agent({
        connect: connector,
        maxResponseSize: input.maxResponseBytes,
        headersTimeout: input.timeoutMs,
        bodyTimeout: input.timeoutMs,
        connectTimeout: input.connectTimeoutMs,
        pipelining: 1,
        connections: 1,
        keepAliveTimeout: 1,
        keepAliveMaxTimeout: 1,
        allowH2: false,
        autoSelectFamily: false,
      });

      const started = performance.now();

      try {
        const response = await agent.request({
          origin: input.url.origin,
          path: `${input.url.pathname || "/"}${input.url.search}`,
          method: input.method,
          headers: {
            "user-agent": CHECKER_USER_AGENT,
            accept: "*/*",
            "accept-encoding": "identity",
          },
          signal: input.signal,
          headersTimeout: input.timeoutMs,
          bodyTimeout: input.timeoutMs,
        });

        timings.ttfbMs = roundMs(performance.now() - started);

        const location = firstHeader(response.headers.location);
        const contentLength = parseContentLength(
          response.headers["content-length"],
        );
        const expectsBody =
          input.method !== "HEAD" &&
          response.statusCode !== 204 &&
          response.statusCode !== 304 &&
          response.statusCode !== 101;

        if (
          expectsBody &&
          contentLength !== null &&
          contentLength > input.maxResponseBytes
        ) {
          response.body?.destroy();
          throw new TransportError("response_too_large");
        }

        let bytesRead = 0;
        if (expectsBody && response.body) {
          for await (const chunk of response.body) {
            bytesRead += chunk.length;
            if (bytesRead > input.maxResponseBytes) {
              response.body.destroy();
              throw new TransportError("response_too_large");
            }
          }
        }

        return {
          statusCode: response.statusCode,
          location,
          contentLength,
          bytesRead,
          timings,
        };
      } catch (error) {
        throw classifyTransportError(error, input.signal);
      } finally {
        await agent.destroy().catch(() => undefined);
      }
    },
  };
}
