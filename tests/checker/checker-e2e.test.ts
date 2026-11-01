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
import { checkMonitor } from "../../worker/checker/checker";
import { createUndiciTransport } from "../../worker/checker/transport";
import { FakeDnsResolver, resolved } from "./helpers";
import {
  canGenerateTestCertificates,
  canTrustTestCertificateAuthority,
  createTestTlsFixtures,
  TEST_TLS_HOSTNAME,
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

function createTlsServer(
  fixture: TestTlsFixtures,
  onRequest: (input: {
    servername: string | undefined;
    host: string | undefined;
  }) => void,
): https.Server {
  const secureContext = tls.createSecureContext({
    key: fixture.serverKey,
    cert: fixture.serverCert,
  });
  let servername: string | undefined;

  const server = https.createServer(
    {
      key: fixture.serverKey,
      cert: fixture.serverCert,
      SNICallback: (name, callback) => {
        servername = name;
        callback(null, secureContext);
      },
    },
    (req, res) => {
      onRequest({ servername, host: req.headers.host });
      res.writeHead(200, { "content-length": "2" });
      res.end("ok");
    },
  );
  server.on("tlsClientError", () => undefined);
  return server;
}

describe("checkMonitor end-to-end transport", () => {
  it("runs a real check through Undici against a trusted local TLS server", async (context) => {
    if (!tlsFixtures) {
      console.warn(
        "checkMonitor TLS integration blocked: OpenSSL or a test-CA-capable Node runtime is unavailable.",
      );
      context.skip();
      return;
    }

    let observedServername: string | undefined;
    let observedHost: string | undefined;
    const server = createTlsServer(tlsFixtures, (input) => {
      observedServername = input.servername;
      observedHost = input.host;
    });
    const port = await listen(server);

    const result = await checkMonitor(
      {
        url: `https://${TEST_TLS_HOSTNAME}:${port}/health?probe=1`,
        method: "GET",
        expectedStatusCodes: [200],
        timeoutSeconds: 5,
        verifyTls: true,
        followRedirects: false,
        maxRedirects: 0,
      },
      {
        dnsResolver: new FakeDnsResolver(() => [resolved("127.0.0.1")]),
        transport: createUndiciTransport(),
        testOnly: {
          addressPolicy: () => true,
          allowedPorts: [port],
        },
        limits: {
          minTimeoutMs: 100,
          maxTimeoutMs: 5_000,
          dnsTimeoutMs: 500,
          connectTimeoutMs: 1_000,
        },
      },
    );

    expect(result.status).toBe("up");
    expect(result.httpStatus).toBe(200);
    expect(result.responseBytes).toBe(2);
    expect(result.redirects).toBe(0);
    expect(result.errorClass).toBeNull();
    expect(observedServername).toBe(TEST_TLS_HOSTNAME);
    expect(observedHost).toBe(`${TEST_TLS_HOSTNAME}:${port}`);
  });

  it("reports a TLS error through checkMonitor for a self-signed local server", async (context) => {
    if (!tlsFixtures) {
      console.warn(
        "checkMonitor TLS integration blocked: OpenSSL or a test-CA-capable Node runtime is unavailable.",
      );
      context.skip();
      return;
    }

    const secureContext = tls.createSecureContext({
      key: tlsFixtures.selfSignedKey,
      cert: tlsFixtures.selfSignedCert,
    });
    const server = https.createServer(
      {
        key: tlsFixtures.selfSignedKey,
        cert: tlsFixtures.selfSignedCert,
        SNICallback: (_name, callback) => callback(null, secureContext),
      },
      (_req, res) => {
        res.writeHead(200);
        res.end("untrusted");
      },
    );
    server.on("tlsClientError", () => undefined);
    const port = await listen(server);

    const result = await checkMonitor(
      {
        url: `https://${TEST_TLS_HOSTNAME}:${port}/health`,
        method: "GET",
        expectedStatusCodes: [200],
        timeoutSeconds: 5,
        verifyTls: true,
      },
      {
        dnsResolver: new FakeDnsResolver(() => [resolved("127.0.0.1")]),
        transport: createUndiciTransport(),
        testOnly: {
          addressPolicy: () => true,
          allowedPorts: [port],
        },
        limits: {
          minTimeoutMs: 100,
          maxTimeoutMs: 5_000,
          dnsTimeoutMs: 500,
          connectTimeoutMs: 1_000,
        },
      },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("tls_error");
    expect(result.httpStatus).toBeNull();
  });
});
