import { describe, expect, it } from "vitest";
import {
  CheckCancelledError,
  TransportError,
} from "../../worker/checker/errors";
import { checkMonitor } from "../../worker/checker/checker";
import {
  baseConfig,
  FakeDnsResolver,
  FakeTransport,
  resolved,
  transportResponse,
} from "./helpers";

const PUBLIC_IPV4 = "93.184.216.34";

function publicDns() {
  return new FakeDnsResolver(() => [resolved(PUBLIC_IPV4)]);
}

describe("checkMonitor", () => {
  it("returns a sanitized success result and pins the validated address", async () => {
    const dns = publicDns();
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 200, bytesRead: 12 }),
    );

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
      now: () => 1_700_000_000_000,
    });

    expect(result).toMatchObject({
      status: "up",
      httpStatus: 200,
      errorClass: null,
      errorMessage: null,
      redirects: 0,
      responseBytes: 12,
      checkedAt: "2023-11-14T22:13:20.000Z",
    });
    expect(result.dnsMs).not.toBeNull();
    expect(result.connectMs).toBe(4);
    expect(result.tlsMs).toBe(6);
    expect(result.ttfbMs).toBe(10);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);

    expect(dns.calls).toHaveLength(1);
    expect(dns.calls[0].hostname).toBe("example.com");
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].pinnedAddress).toEqual({
      address: PUBLIC_IPV4,
      family: 4,
    });
    expect(transport.calls[0].tlsServername).toBe("example.com");
    expect(transport.calls[0].url.toString()).toBe(
      "https://example.com/health",
    );
    expect(transport.calls[0].method).toBe("GET");
    expect(transport.calls[0].signal.aborted).toBe(false);
  });

  it("supports HEAD without reading a body", async () => {
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 200, bytesRead: 0 }),
    );

    const result = await checkMonitor(baseConfig({ method: "HEAD" }), {
      dnsResolver: publicDns(),
      transport,
    });

    expect(result.status).toBe("up");
    expect(result.httpStatus).toBe(200);
    expect(result.responseBytes).toBe(0);
    expect(transport.calls[0].method).toBe("HEAD");
  });

  it("accepts a lowercase method and expected status list", async () => {
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 204 }),
    );

    const result = await checkMonitor(
      baseConfig({ method: "get", expectedStatusCodes: [200, 204] }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("up");
    expect(transport.calls[0].method).toBe("GET");
  });

  it("reports an unexpected status as down without exposing the URL", async () => {
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 503 }),
    );

    const result = await checkMonitor(
      baseConfig({ url: "https://example.com/health?token=super-secret" }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("down");
    expect(result.httpStatus).toBe(503);
    expect(result.errorClass).toBe("http_status_mismatch");
    expect(result.errorMessage).toBe(
      "The response status did not match the expected status.",
    );
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("example.com");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("treats a redirect status as a normal status when following is disabled", async () => {
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 302, location: "/next" }),
    );

    const result = await checkMonitor(
      baseConfig({ expectedStatusCodes: [302] }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("up");
    expect(result.httpStatus).toBe(302);
    expect(result.redirects).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });

  it("maps DNS failures to a safe dns_failure result", async () => {
    const dns = new FakeDnsResolver(() => {
      throw new Error("resolver leaked a secret hostname");
    });
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
    });

    expect(result.status).toBe("error");
    expect(result.httpStatus).toBeNull();
    expect(result.errorClass).toBe("dns_failure");
    expect(result.errorMessage).toBe("DNS resolution failed.");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(transport.calls).toHaveLength(0);
  });

  it("maps a malformed DNS answer to dns_failure, not blocked_target", async () => {
    const dns = new FakeDnsResolver(() => [
      { address: "not-an-ip", family: 4 },
    ]);
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("dns_failure");
    expect(result.errorMessage).toBe("DNS resolution failed.");
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects mixed public and private DNS answers as a whole", async () => {
    const dns = new FakeDnsResolver(() => [
      resolved(PUBLIC_IPV4),
      resolved("10.0.0.5"),
    ]);
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("blocked_target");
    expect(result.errorMessage).toBe("The destination is not allowed.");
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a private IP literal before any transport call", async () => {
    const dns = publicDns();
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(
      baseConfig({ url: "http://127.0.0.1/" }),
      { dnsResolver: dns, transport },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("blocked_target");
    expect(dns.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("normalizes unusual numeric host forms before blocking them", async () => {
    const dns = publicDns();
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(
      baseConfig({ url: "http://2130706433/" }),
      { dnsResolver: dns, transport },
    );

    expect(result.errorClass).toBe("blocked_target");
    expect(dns.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("blocks deprecated IPv4-compatible IPv6 literals", async () => {
    const dns = publicDns();
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(
      baseConfig({ url: "http://[::7f00:1]/" }),
      { dnsResolver: dns, transport },
    );

    expect(result.errorClass).toBe("blocked_target");
    expect(dns.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("uses the validated literal and disables SNI for an IP-literal target", async () => {
    const dns = publicDns();
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 200 }),
    );

    const result = await checkMonitor(
      baseConfig({ url: "https://8.8.8.8/health" }),
      { dnsResolver: dns, transport },
    );

    expect(result.status).toBe("up");
    expect(dns.calls).toHaveLength(0);
    expect(transport.calls[0].pinnedAddress).toEqual({
      address: "8.8.8.8",
      family: 4,
    });
    expect(transport.calls[0].tlsServername).toBeNull();
  });

  it("resolves once and does not perform a second lookup before the request", async () => {
    let lookups = 0;
    const dns = new FakeDnsResolver(() => {
      lookups += 1;
      return [resolved(PUBLIC_IPV4)];
    });
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 200 }),
    );

    await checkMonitor(baseConfig(), { dnsResolver: dns, transport });

    expect(lookups).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    ["POST method", { method: "POST" }],
    ["TLS verification disabled", { verifyTls: false }],
    ["body assertion", { expectedBodyText: "ok" }],
    ["regex body assertion", { expectedBodyIsRegex: true }],
    ["request secrets", { hasRequestSecrets: true }],
    ["timeout below minimum", { timeoutSeconds: 0 }],
    ["timeout above maximum", { timeoutSeconds: 61 }],
    ["empty status list", { expectedStatusCodes: [] }],
    ["status below 100", { expectedStatusCodes: [99] }],
    ["status above 599", { expectedStatusCodes: [600] }],
    ["non-integer status", { expectedStatusCodes: [200.5] }],
    [
      "redirects enabled without a hop budget",
      { followRedirects: true, maxRedirects: 0 },
    ],
    [
      "redirect budget above the server cap",
      { followRedirects: true, maxRedirects: 6 },
    ],
    [
      "redirect budget when following is disabled",
      { followRedirects: false, maxRedirects: 1 },
    ],
    ["unsupported scheme", { url: "ftp://example.com/" }],
    ["non-standard port", { url: "https://example.com:8443/" }],
    ["URL credentials", { url: "https://user:pass@example.com/" }],
  ])("rejects unsupported configuration: %s", async (_label, overrides) => {
    const dns = publicDns();
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(baseConfig(overrides), {
      dnsResolver: dns,
      transport,
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("unsupported_configuration");
    expect(dns.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("follows redirects manually, re-resolving and re-pinning every hop", async () => {
    const dns = new FakeDnsResolver(() => [resolved(PUBLIC_IPV4)]);
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        return transportResponse({ statusCode: 302, location: "/one" });
      }
      if (index === 1) {
        return transportResponse({
          statusCode: 301,
          location: "https://other.example/two",
        });
      }
      return transportResponse({ statusCode: 200, bytesRead: 3 });
    });

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 2 }),
      { dnsResolver: dns, transport },
    );

    expect(result.status).toBe("up");
    expect(result.httpStatus).toBe(200);
    expect(result.redirects).toBe(2);
    expect(dns.calls.map((call) => call.hostname)).toEqual([
      "example.com",
      "example.com",
      "other.example",
    ]);
    expect(transport.calls.map((call) => call.url.toString())).toEqual([
      "https://example.com/health",
      "https://example.com/one",
      "https://other.example/two",
    ]);
    expect(transport.calls.map((call) => call.tlsServername)).toEqual([
      "example.com",
      "example.com",
      "other.example",
    ]);
    expect(transport.calls.every((call) => call.pinnedAddress.address === PUBLIC_IPV4)).toBe(
      true,
    );
  });

  it("detects a redirect loop without re-requesting the same URL", async () => {
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 302, location: "/health" }),
    );

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 5 }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("redirect_loop");
    expect(result.httpStatus).toBe(302);
    expect(result.redirects).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });

  it("caps the redirect chain at the configured budget", async () => {
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        return transportResponse({ statusCode: 302, location: "/one" });
      }
      if (index === 1) {
        return transportResponse({ statusCode: 302, location: "/two" });
      }
      return transportResponse({ statusCode: 200 });
    });

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 1 }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("redirect_loop");
    expect(result.redirects).toBe(1);
    expect(transport.calls).toHaveLength(2);
  });

  it("blocks a redirect to a private address", async () => {
    const dns = publicDns();
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 302, location: "https://127.0.0.1/" }),
    );

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 2 }),
      { dnsResolver: dns, transport },
    );

    expect(result.errorClass).toBe("blocked_target");
    expect(dns.calls).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
  });

  it("re-resolves a redirect and rejects DNS rebinding", async () => {
    const dns = new FakeDnsResolver((_hostname, _options, index) =>
      index === 0 ? [resolved(PUBLIC_IPV4)] : [resolved("127.0.0.1")],
    );
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 302, location: "/next" }),
    );

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 2 }),
      { dnsResolver: dns, transport },
    );

    expect(result.errorClass).toBe("blocked_target");
    expect(dns.calls).toHaveLength(2);
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects an HTTPS-to-HTTP redirect downgrade by default", async () => {
    const transport = new FakeTransport(() =>
      transportResponse({
        statusCode: 302,
        location: "http://other.example/plain",
      }),
    );

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 2 }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("redirect_failure");
    expect(result.redirects).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });

  it("follows an HTTP-to-HTTPS upgrade and an HTTPS-to-HTTPS redirect", async () => {
    const dns = new FakeDnsResolver(() => [resolved(PUBLIC_IPV4)]);
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        return transportResponse({
          statusCode: 301,
          location: "https://example.com/secure",
        });
      }
      if (index === 1) {
        return transportResponse({
          statusCode: 302,
          location: "https://other.example/final",
        });
      }
      return transportResponse({ statusCode: 200 });
    });

    const result = await checkMonitor(
      baseConfig({
        url: "http://example.com/start",
        followRedirects: true,
        maxRedirects: 3,
      }),
      { dnsResolver: dns, transport },
    );

    expect(result.status).toBe("up");
    expect(result.redirects).toBe(2);
    expect(transport.calls.map((call) => call.url.toString())).toEqual([
      "http://example.com/start",
      "https://example.com/secure",
      "https://other.example/final",
    ]);
    expect(transport.calls.map((call) => call.tlsServername)).toEqual([
      "example.com",
      "example.com",
      "other.example",
    ]);
  });

  it("rejects a downgrade that appears later in an HTTPS redirect chain", async () => {
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        return transportResponse({
          statusCode: 302,
          location: "https://example.com/next",
        });
      }
      return transportResponse({
        statusCode: 302,
        location: "http://example.com/plain",
      });
    });

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 3 }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("redirect_failure");
    expect(result.redirects).toBe(1);
    expect(transport.calls.map((call) => call.url.toString())).toEqual([
      "https://example.com/health",
      "https://example.com/next",
    ]);
  });

  it("falls back to the next validated public address after a connection failure", async () => {
    const dns = new FakeDnsResolver(() => [
      resolved(PUBLIC_IPV4),
      resolved("8.8.8.8"),
    ]);
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        throw new TransportError("connection_refused");
      }
      return transportResponse({ statusCode: 200, bytesRead: 7 });
    });

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
      limits: { maxAddressAttempts: 2 },
    });

    expect(result.status).toBe("up");
    expect(result.httpStatus).toBe(200);
    expect(result.responseBytes).toBe(7);
    expect(dns.calls).toHaveLength(1);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.map((call) => call.pinnedAddress)).toEqual([
      { address: PUBLIC_IPV4, family: 4 },
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(transport.calls.map((call) => call.tlsServername)).toEqual([
      "example.com",
      "example.com",
    ]);
  });

  it("tries a connection-level timeout on another validated address", async () => {
    const dns = new FakeDnsResolver(() => [
      resolved(PUBLIC_IPV4),
      resolved("8.8.8.8"),
    ]);
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        throw new TransportError("timeout");
      }
      return transportResponse({ statusCode: 200 });
    });

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
      limits: { maxAddressAttempts: 2 },
    });

    expect(result.status).toBe("up");
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].tlsServername).toBe("example.com");
    expect(transport.calls[1].tlsServername).toBe("example.com");
  });

  it("stops after the strict address-attempt cap when every address fails", async () => {
    const dns = new FakeDnsResolver(() => [
      resolved(PUBLIC_IPV4),
      resolved("8.8.8.8"),
      resolved("1.1.1.1"),
    ]);
    const transport = new FakeTransport(() => {
      throw new TransportError("connection_failure");
    });

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
      limits: { maxAddressAttempts: 2 },
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("connection_failure");
    expect(result.httpStatus).toBeNull();
    expect(dns.calls).toHaveLength(1);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.map((call) => call.pinnedAddress.address)).toEqual([
      PUBLIC_IPV4,
      "8.8.8.8",
    ]);
  });

  it("does not retry a genuine HTTP error response on another address", async () => {
    const dns = new FakeDnsResolver(() => [
      resolved(PUBLIC_IPV4),
      resolved("8.8.8.8"),
    ]);
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        return transportResponse({ statusCode: 503 });
      }
      return transportResponse({ statusCode: 200 });
    });

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
      limits: { maxAddressAttempts: 2 },
    });

    expect(result.status).toBe("down");
    expect(result.httpStatus).toBe(503);
    expect(result.errorClass).toBe("http_status_mismatch");
    expect(transport.calls).toHaveLength(1);
  });

  it("does not retry a TLS verification failure on another address", async () => {
    const dns = new FakeDnsResolver(() => [
      resolved(PUBLIC_IPV4),
      resolved("8.8.8.8"),
    ]);
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        throw new TransportError("tls_error");
      }
      return transportResponse({ statusCode: 200 });
    });

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: dns,
      transport,
      limits: { maxAddressAttempts: 2 },
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("tls_error");
    expect(result.httpStatus).toBeNull();
    expect(transport.calls).toHaveLength(1);
  });

  it("does not extend the total deadline while trying another address", async () => {
    const dns = new FakeDnsResolver(() => [
      resolved(PUBLIC_IPV4),
      resolved("8.8.8.8"),
    ]);
    const transport = new FakeTransport((_input, index) => {
      if (index === 0) {
        return new Promise(() => {
          // Intentionally never settles; the total deadline must abort it.
        });
      }
      return transportResponse({ statusCode: 200 });
    });

    const result = await checkMonitor(baseConfig({ timeoutSeconds: 1 }), {
      dnsResolver: dns,
      transport,
      limits: {
        minTimeoutMs: 100,
        maxTimeoutMs: 2_000,
        dnsTimeoutMs: 500,
        connectTimeoutMs: 500,
        maxAddressAttempts: 2,
      },
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("timeout");
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].signal.aborted).toBe(true);
  });

  it.each([
    ["unsupported scheme", "ftp://example.com/"],
    ["credentials", "http://user:pass@example.com/"],
    ["non-standard port", "https://example.com:8443/"],
    ["malformed URL", "http://[::1"],
  ])("rejects an unsafe redirect target: %s", async (_label, location) => {
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 302, location }),
    );

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 2 }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("redirect_failure");
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects a redirect response with no Location header", async () => {
    const transport = new FakeTransport(() =>
      transportResponse({ statusCode: 302, location: null }),
    );

    const result = await checkMonitor(
      baseConfig({ followRedirects: true, maxRedirects: 2 }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.errorClass).toBe("redirect_failure");
    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    ["connection_refused", "connection_refused"],
    ["connection_failure", "connection_failure"],
    ["timeout", "timeout"],
    ["tls_error", "tls_error"],
    ["response_too_large", "response_too_large"],
    ["internal_error", "internal_error"],
  ] as const)("maps transport error %s to %s", async (kind, expected) => {
    const transport = new FakeTransport(() => {
      throw new TransportError(kind);
    });

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: publicDns(),
      transport,
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe(expected);
    expect(result.errorMessage).not.toBeNull();
    expect(result.httpStatus).toBeNull();
  });

  it("maps an aborted transport without a caller abort to internal_error", async () => {
    const transport = new FakeTransport(() => {
      throw new TransportError("aborted");
    });

    const result = await checkMonitor(baseConfig(), {
      dnsResolver: publicDns(),
      transport,
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("internal_error");
    expect(result.errorMessage).toBe("The checker encountered an internal error.");
  });

  it("sanitizes an unknown thrown error", async () => {
    const transport = new FakeTransport(() => {
      throw new Error("raw transport detail with secret-token");
    });

    const result = await checkMonitor(
      baseConfig({ url: "https://example.com/health?token=secret-token" }),
      { dnsResolver: publicDns(), transport },
    );

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("internal_error");
    expect(result.errorMessage).toBe("The checker encountered an internal error.");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("raw transport detail");
    expect(JSON.stringify(result)).not.toContain("example.com");
  });

  it("enforces the total timeout and aborts the transport signal", async () => {
    let seenSignal: AbortSignal | null = null;
    const transport = new FakeTransport((input) => {
      seenSignal = input.signal;
      return new Promise(() => {
        // Intentionally never settles.
      });
    });

    const result = await checkMonitor(baseConfig({ timeoutSeconds: 1 }), {
      dnsResolver: publicDns(),
      transport,
      limits: {
        minTimeoutMs: 100,
        maxTimeoutMs: 2_000,
        dnsTimeoutMs: 500,
        connectTimeoutMs: 500,
      },
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("timeout");
    expect(result.errorMessage).toBe("The check timed out.");
    expect(seenSignal).not.toBeNull();
    expect(seenSignal!.aborted).toBe(true);
  });

  it("treats a total timeout during DNS as timeout, not dns_failure", async () => {
    const dns = new FakeDnsResolver(
      () =>
        new Promise(() => {
          // Intentionally ignores the signal to prove the outer deadline wins.
        }),
    );
    const transport = new FakeTransport(() => transportResponse());

    const result = await checkMonitor(baseConfig({ timeoutSeconds: 1 }), {
      dnsResolver: dns,
      transport,
      limits: {
        minTimeoutMs: 100,
        maxTimeoutMs: 2_000,
        dnsTimeoutMs: 500,
        connectTimeoutMs: 500,
      },
    });

    expect(result.status).toBe("error");
    expect(result.errorClass).toBe("timeout");
    expect(transport.calls).toHaveLength(0);
  });

  it("propagates caller cancellation instead of returning an outage result", async () => {
    const controller = new AbortController();
    let transportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transportStarted = resolve;
    });

    const transport = new FakeTransport((input) => {
      transportStarted();
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(input.signal.reason),
          { once: true },
        );
      });
    });

    const pending = checkMonitor(baseConfig(), {
      dnsResolver: publicDns(),
      transport,
      signal: controller.signal,
    });

    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(CheckCancelledError);
    expect(transport.calls[0].signal.aborted).toBe(true);
  });

  it("does not start work when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const dns = publicDns();
    const transport = new FakeTransport(() => transportResponse());

    await expect(
      checkMonitor(baseConfig(), {
        dnsResolver: dns,
        transport,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CheckCancelledError);

    expect(dns.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });
});
