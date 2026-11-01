import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  createUndiciTransport,
  type HttpRequestInput,
} from "../../worker/checker/transport";
import {
  canGenerateTestCertificates,
  canTrustTestCertificateAuthority,
  createTestTlsFixtures,
  TEST_TLS_HOSTNAME,
  TEST_TLS_WRONG_HOSTNAME,
  trustTestCertificateAuthority,
  type TestTlsFixtures,
} from "./tls-fixtures";

const tlsFixturesAvailable =
  canGenerateTestCertificates() && canTrustTestCertificateAuthority();

let tlsFixtures: TestTlsFixtures | null = null;
let restoreTrustStore: (() => void) | null = null;

beforeAll(() => {
  if (!tlsFixturesAvailable) return;
  tlsFixtures = createTestTlsFixtures();
  restoreTrustStore = trustTestCertificateAuthority(tlsFixtures.caCert);
});

afterAll(() => {
  restoreTrustStore?.();
  tlsFixtures?.cleanup();
});

const servers: Array<net.Server> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await closeServer(server);
  }
});

async function listen(
  server: net.Server,
  host = "127.0.0.1",
): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
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

  it("accepts a trusted test certificate and verifies the hostname and SNI", async (context) => {
    if (!tlsFixtures) {
      console.warn(
        "TLS fixture test blocked: OpenSSL or a test-CA-capable Node runtime is unavailable.",
      );
      context.skip();
      return;
    }

    let seenServername: string | undefined;
    const secureContext = tls.createSecureContext({
      key: tlsFixtures.serverKey,
      cert: tlsFixtures.serverCert,
    });
    const server = https.createServer(
      {
        key: tlsFixtures.serverKey,
        cert: tlsFixtures.serverCert,
        SNICallback: (servername, callback) => {
          seenServername = servername;
          callback(null, secureContext);
        },
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    );
    const port = await listen(server);
    const transport = createUndiciTransport();

    const result = await transport.request(
      request(`https://${TEST_TLS_HOSTNAME}:${port}/`, {
        tlsServername: TEST_TLS_HOSTNAME,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.bytesRead).toBe(2);
    expect(seenServername).toBe(TEST_TLS_HOSTNAME);
  });

  it("rejects a trusted CA certificate issued for the wrong hostname", async (context) => {
    if (!tlsFixtures) {
      console.warn(
        "TLS fixture test blocked: OpenSSL or a test-CA-capable Node runtime is unavailable.",
      );
      context.skip();
      return;
    }

    let seenServername: string | undefined;
    const secureContext = tls.createSecureContext({
      key: tlsFixtures.wrongHostKey,
      cert: tlsFixtures.wrongHostCert,
    });
    const server = https.createServer(
      {
        key: tlsFixtures.wrongHostKey,
        cert: tlsFixtures.wrongHostCert,
        SNICallback: (servername, callback) => {
          seenServername = servername;
          callback(null, secureContext);
        },
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("wrong host");
      },
    );
    server.on("tlsClientError", () => undefined);
    const port = await listen(server);
    const transport = createUndiciTransport();

    await expect(
      transport.request(
        request(`https://${TEST_TLS_HOSTNAME}:${port}/`, {
          tlsServername: TEST_TLS_HOSTNAME,
        }),
      ),
    ).rejects.toMatchObject({
      name: "TransportError",
      kind: "tls_error",
    });

    expect(seenServername).toBe(TEST_TLS_HOSTNAME);
    expect(TEST_TLS_WRONG_HOSTNAME).not.toBe(TEST_TLS_HOSTNAME);
  });

  it("rejects a self-signed certificate while preserving SNI", async (context) => {
    if (!tlsFixtures) {
      console.warn(
        "TLS fixture test blocked: OpenSSL or a test-CA-capable Node runtime is unavailable.",
      );
      context.skip();
      return;
    }

    let seenServername: string | undefined;
    const secureContext = tls.createSecureContext({
      key: tlsFixtures.selfSignedKey,
      cert: tlsFixtures.selfSignedCert,
    });
    const server = https.createServer(
      {
        key: tlsFixtures.selfSignedKey,
        cert: tlsFixtures.selfSignedCert,
        SNICallback: (servername, callback) => {
          seenServername = servername;
          callback(null, secureContext);
        },
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("self signed");
      },
    );
    server.on("tlsClientError", () => undefined);
    const port = await listen(server);
    const transport = createUndiciTransport();

    await expect(
      transport.request(
        request(`https://${TEST_TLS_HOSTNAME}:${port}/`, {
          tlsServername: TEST_TLS_HOSTNAME,
        }),
      ),
    ).rejects.toMatchObject({
      name: "TransportError",
      kind: "tls_error",
    });

    expect(seenServername).toBe(TEST_TLS_HOSTNAME);
  });

  it("connects over IPv6 loopback when the environment supports it", async (context) => {
    const probe = net.createServer();
    const ipv6Available = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => resolve(true));
    });
    await closeServer(probe).catch(() => undefined);

    if (!ipv6Available) {
      console.warn("IPv6 loopback is unavailable; the IPv6 transport test is blocked.");
      context.skip();
      return;
    }

    let hostHeader: string | undefined;
    const server = http.createServer((req, res) => {
      hostHeader = req.headers.host;
      res.writeHead(200);
      res.end("ipv6");
    });
    const port = await listen(server, "::1");
    const transport = createUndiciTransport();

    const result = await transport.request(
      request(`http://checker.test:${port}/ipv6`, {
        pinnedAddress: { address: "::1", family: 6 },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.bytesRead).toBe(4);
    expect(hostHeader).toBe(`checker.test:${port}`);
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
