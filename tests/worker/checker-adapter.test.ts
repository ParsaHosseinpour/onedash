import { describe, expect, it } from "vitest";
import {
  CheckCancelledError,
  SAFE_MESSAGES,
  type CheckResult,
  type MonitorCheckConfig,
} from "../../worker/checker";
import {
  CustomerExecutionLockedError,
  InvalidFixtureError,
  createFixtureChecker,
  createLockedChecker,
  createRealChecker,
} from "../../worker/checker/adapter";
import type { ClaimedJob } from "../../worker/queue/queue-client";

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    jobId: "job-1",
    leaseToken: "lease-1",
    monitorId: "monitor-1",
    region: "test-1",
    scheduledFor: "2026-01-02T03:04:05.000Z",
    attempts: 1,
    maxAttempts: 5,
    url: "https://fixture.test/health",
    method: "GET",
    expectedStatusCodes: [200],
    timeoutSeconds: 5,
    verifyTls: true,
    followRedirects: false,
    maxRedirects: 0,
    hasRequestSecrets: false,
    ...overrides,
  };
}

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    status: "up",
    httpStatus: 200,
    responseTimeMs: 10,
    dnsMs: 1,
    connectMs: 1,
    tlsMs: 1,
    ttfbMs: 1,
    totalMs: 10,
    errorClass: null,
    errorMessage: null,
    redirects: 0,
    responseBytes: 100,
    checkedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

describe("createRealChecker", () => {
  it("passes only the minimum checker configuration and the abort signal", async () => {
    let capturedConfig: MonitorCheckConfig | undefined;
    let capturedOptions: { signal?: AbortSignal } | undefined;
    const checker = createRealChecker({
      checkMonitor: async (config, options) => {
        capturedConfig = config;
        capturedOptions = options;
        return result();
      },
    });

    const controller = new AbortController();
    const check = await checker.check(
      job({
        url: "https://fixture.test/health",
        method: "HEAD",
        expectedStatusCodes: [204],
        timeoutSeconds: 7,
        followRedirects: true,
        maxRedirects: 2,
      }),
      controller.signal,
    );

    expect(check).toEqual(result());
    expect(capturedConfig).toEqual({
      url: "https://fixture.test/health",
      method: "HEAD",
      expectedStatusCodes: [204],
      timeoutSeconds: 7,
      verifyTls: true,
      followRedirects: true,
      maxRedirects: 2,
      hasRequestSecrets: false,
    });
    expect(capturedConfig).not.toHaveProperty("monitorId");
    expect(capturedConfig).not.toHaveProperty("organizationId");
    expect(capturedConfig).not.toHaveProperty("leaseToken");
    expect(capturedOptions?.signal).toBe(controller.signal);
  });
});

describe("createFixtureChecker", () => {
  it("returns a deterministic up result without network access", async () => {
    const checker = createFixtureChecker({
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    const check = await checker.check(job(), new AbortController().signal);

    expect(check.status).toBe("up");
    expect(check.httpStatus).toBe(200);
    expect(check.errorClass).toBeNull();
    expect(check.checkedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(check.responseBytes).toBe(128);
  });

  it("refuses non-.test destinations", async () => {
    const checker = createFixtureChecker();
    await expect(
      checker.check(
        job({ url: "https://customer.example/health" }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(InvalidFixtureError);
  });

  it("returns an unsupported-configuration result for request secrets", async () => {
    const checker = createFixtureChecker();
    const check = await checker.check(
      job({ hasRequestSecrets: true }),
      new AbortController().signal,
    );
    expect(check.status).toBe("error");
    expect(check.errorClass).toBe("unsupported_configuration");
  });

  it("returns an unsupported-configuration result when TLS verification is disabled", async () => {
    const checker = createFixtureChecker();
    const check = await checker.check(
      job({ verifyTls: false }),
      new AbortController().signal,
    );
    expect(check.status).toBe("error");
    expect(check.errorClass).toBe("unsupported_configuration");
  });

  it("supports a test-supplied result override", async () => {
    const override = result({
      status: "down",
      httpStatus: 503,
      errorClass: "http_status_mismatch",
      errorMessage: SAFE_MESSAGES.http_status_mismatch,
    });
    const checker = createFixtureChecker({
      results: { "https://fixture.test/health": override },
    });
    const check = await checker.check(job(), new AbortController().signal);
    expect(check).toEqual(override);
  });

  it("honours an already-aborted signal", async () => {
    const checker = createFixtureChecker();
    const controller = new AbortController();
    controller.abort();
    await expect(checker.check(job(), controller.signal)).rejects.toBeInstanceOf(
      CheckCancelledError,
    );
  });
});

describe("createLockedChecker", () => {
  it("always refuses customer execution", async () => {
    const checker = createLockedChecker();
    await expect(
      checker.check(job(), new AbortController().signal),
    ).rejects.toBeInstanceOf(CustomerExecutionLockedError);
  });
});
