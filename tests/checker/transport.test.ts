import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUndiciTransport,
  type HttpRequestInput,
} from "../../worker/checker/transport";

const key = readFileSync(
  join(process.cwd(), "tests", "checker", "fixtures", "checker-test-key.pem"),
  "utf8",
);
const cert = readFileSync(
  join(process.cwd(), "tests", "checker", "fixtures", "checker-test-cert.pem"),
  "utf8",
);

const servers: Array<net.Server> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await closeServer(server);
  }
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function request(
  url: string,
  overrides: Partial<HttpRequestInput> = {},
): HttpRequestInput {
  return {
    url: new URL(url),
    method: "GET",
    pinnedAddress: { address: "127.0.0.1", family: 4 },
    tlsServername: null,
    timeoutMs: 2_000,
    connectTimeoutMs: 1_000,
    maxResponseBytes: 1_048_576,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("Undici pinned transport", () => {
  it("dials the pinned address while preserving the Host header", async () => {
    let hostHeader: string | undefined;
    const server = http.createServer((req, res) => {
      hostHeader = req.headers.host;
      res.writeHead(200, { "content-length": "5" });
      res.end("hello");
    });
    const port = await listen(server);
    const transport = createUndiciTransport();

    const result = await transport.request(
      request(`http://checker.test:${port}/health?probe=1`),
    );

    expect(result.statusCode).toBe(200);
    expect(result.bytesRead).toBe(5);
    expect(result.contentLength).toBe(5);
    expect(result.location).toBeNull();
    expect(result.timings.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(hostHeader).toBe(`checker.test:${port}`);
    expect("body" in result).toBe(false);
  });

  it("does not follow redirects and reports the Location header", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(302, { location: "/somewhere-else" });
      res.end();
    });
    const port = await listen(server);
    const transport = createUndiciTransport();

    const result = await transport.request(
      request(`http://checker.test:${port}/start`),
    );

    expect(result.statusCode).toBe(302);
    expect(result.location).toBe("/somewhere-else");
    expect(requests).toBe(1);
  });

  it("sends HEAD and reads no body", async () => {
    let method: string | undefined;
    let path: string | undefined;
    const server = http.createServer((req, res) => {
      method = req.method;
      path = req.url;
      res.writeHead(200, { "content-length": "5" });
      res.end();
    });
    const port = await listen(server);
    const transport = createUndiciTransport();

    const result = await transport.request(
      request(`http://checker.test:${port}/head?probe=1`, { method: "HEAD" }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.bytesRead).toBe(0);
    expect(method).toBe("HEAD");
    expect(path).toBe("/head?probe=1");
  });

  it("rejects a response whose Content-Length exceeds the cap", async () => {
    const server = http.createServer((_req, res) => {
      res.on("error", () => undefined);
      res.writeHead(200, { "content-length": "100" });
      res.end(Buffer.alloc(100));
    });
    const port = await listen(server);
    const transport = createUndiciTransport();

    await expect(
      transport.request(
        request(`http://checker.test:${port}/large`, {
          maxResponseBytes: 10,
        }),
      ),
    ).rejects.toMatchObject({
      name: "TransportError",
      kind: "response_too_large",
    });
  });

  it("stops reading a streamed response that exceeds the cap", async () => {
    const server = http.createServer((_req, res) => {
      res.on("error", () => undefined);
      res.writeHead(200);
      res.write(Buffer.alloc(8));
      setTimeout(() => {
        if (!res.destroyed) {
          res.write(Buffer.alloc(8));
          res.end();
        }
      }, 5);
    });
    const port = await listen(server);
    const transport = createUndiciTransport();

    await expect(
      transport.request(
        request(`http://checker.test:${port}/stream`, {
          maxResponseBytes: 10,
        }),
      ),
    ).rejects.toMatchObject({
      name: "TransportError",
      kind: "response_too_large",
    });
  });

  it("reports a refused connection", async () => {
    const probe = net.createServer();
    const port = await listen(probe);
    await closeServer(probe);
    servers.splice(servers.indexOf(probe), 1);

    const transport = createUndiciTransport();

    await expect(
      transport.request(request(`http://checker.test:${port}/`)),
    ).rejects.toMatchObject({
      name: "TransportError",
      kind: "connection_refused",
    });
  });

  it("enforces the connect timeout", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    const port = await listen(server);
    const transport = createUndiciTransport();

    try {
      await expect(
        transport.request(
          request(`https://checker.test:${port}/`, {
            tlsServername: "checker.test",
            connectTimeoutMs: 50,
            timeoutMs: 1_000,
          }),
        ),
      ).rejects.toMatchObject({
        name: "TransportError",
        kind: "timeout",
      });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it("keeps TLS verification enabled and preserves SNI", async () => {
    let seenServername: string | undefined;
    const context = tls.createSecureContext({ key, cert });
    const server = https.createServer(
      {
        key,
        cert,
        SNICallback: (servername, callback) => {
          seenServername = servername;
          callback(null, context);
        },
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    );
    server.on("tlsClientError", () => undefined);
    const port = await listen(server);
    const transport = createUndiciTransport();

    await expect(
      transport.request(
        request(`https://checker.test:${port}/`, {
          tlsServername: "checker.test",
        }),
      ),
    ).rejects.toMatchObject({
      name: "TransportError",
      kind: "tls_error",
    });

    expect(seenServername).toBe("checker.test");
  });

  it("aborts an in-flight request and does not leak a result", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const server = http.createServer((_req, res) => {
      res.on("error", () => undefined);
      requestStarted();
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200);
          res.end("late");
        }
      }, 200);
    });
    const port = await listen(server);
    const controller = new AbortController();
    const transport = createUndiciTransport();

    const pending = transport.request(
      request(`http://checker.test:${port}/slow`, {
        signal: controller.signal,
      }),
    );

    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "TransportError",
      kind: "aborted",
    });
  });

  it("reports a TLS error for a plaintext response on an HTTPS origin", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("plain");
    });
    const port = await listen(server);
    const transport = createUndiciTransport();

    await expect(
      transport.request(
        request(`https://checker.test:${port}/`, {
          tlsServername: "checker.test",
        }),
      ),
    ).rejects.toMatchObject({
      name: "TransportError",
      kind: "tls_error",
    });
  });
});
