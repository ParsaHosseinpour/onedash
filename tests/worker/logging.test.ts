import { describe, expect, it } from "vitest";
import {
  CheckCancelledError,
  CheckerError,
  SAFE_MESSAGES,
  TransportError,
} from "../../worker/checker";
import {
  classifyError,
  createJsonLogger,
  jobErrorClass,
  jobFailureDisposition,
  sanitizeReason,
} from "../../worker/logging";

function captureLogger(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  const logger = createJsonLogger({
    level,
    sink: (line) => lines.push(line),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { logger, lines };
}

describe("createJsonLogger", () => {
  it("writes structured events", () => {
    const { logger, lines } = captureLogger();
    logger.info("worker_started", {
      executionMode: "fixtures",
      concurrency: 2,
      fixtureHostCount: 1,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      time: "2026-01-02T03:04:05.000Z",
      level: "info",
      event: "worker_started",
      executionMode: "fixtures",
      concurrency: 2,
      fixtureHostCount: 1,
    });
  });

  it("drops customer URLs, monitor IDs, secrets, and raw messages", () => {
    const { logger, lines } = captureLogger();
    logger.info("job_started", {
      jobId: "job-1",
      url: "https://customer.example/private",
      monitorUrl: "https://customer.example/private",
      monitorId: "monitor-secret",
      organizationId: "org-secret",
      hostname: "customer.example",
      secret: "shh",
      token: "shh",
      authorization: "Bearer shh",
      email: "person@example.com",
      message: "raw error with https://customer.example",
    });

    const line = lines[0];
    expect(line).toContain("job-1");
    for (const forbidden of [
      "customer.example",
      "monitor-secret",
      "org-secret",
      "person@example.com",
      "Bearer shh",
      "raw error",
    ]) {
      expect(line).not.toContain(forbidden);
    }
  });

  it("sanitizes reasons and error codes", () => {
    const { logger, lines } = captureLogger();
    logger.warn("job_abandoned", {
      reason: "lease lost https://customer.example",
      errorCode: "23505\nsecret",
    });

    const entry = JSON.parse(lines[0]);
    expect(entry.reason).toBe("redacted");
    expect(entry.errorCode).toBeUndefined();
  });

  it("keeps fixed reason codes but redacts hostnames, URLs, and paths", () => {
    expect(sanitizeReason("lease_lost")).toBe("lease_lost");
    expect(sanitizeReason("execution_disabled:fixtures")).toBe(
      "execution_disabled:fixtures",
    );
    for (const value of [
      "https://customer.example/private",
      "customer.example",
      "person@example.com",
      "C:\\secrets\\config",
      "lease lost at customer.example",
      "x".repeat(61),
    ]) {
      expect(sanitizeReason(value)).toBe("redacted");
    }
  });

  it("filters below the configured level", () => {
    const { logger, lines } = captureLogger("warn");
    logger.debug("debug_event");
    logger.info("info_event");
    logger.warn("warn_event");
    logger.error("error_event");
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      "warn_event",
      "error_event",
    ]);
  });

  it("never throws when the sink throws", () => {
    const logger = createJsonLogger({
      sink: () => {
        throw new Error("sink failure");
      },
    });
    expect(() => logger.info("safe_event", { jobId: "job-1" })).not.toThrow();
  });
});

describe("classifyError", () => {
  it("classifies checker errors", () => {
    expect(classifyError(new CheckerError("timeout", SAFE_MESSAGES.timeout))).toEqual({
      errorClass: "timeout",
      errorCode: null,
    });
  });

  it("classifies transport errors", () => {
    expect(classifyError(new TransportError("connection_refused"))).toEqual({
      errorClass: "connection_refused",
      errorCode: null,
    });
    expect(classifyError(new TransportError("aborted"))).toEqual({
      errorClass: "cancelled",
      errorCode: null,
    });
  });

  it("classifies cancellation", () => {
    expect(classifyError(new CheckCancelledError())).toEqual({
      errorClass: "cancelled",
      errorCode: null,
    });
  });

  it("keeps only SQLSTATE-shaped codes", () => {
    expect(classifyError({ code: "42501" })).toEqual({
      errorClass: "worker_error",
      errorCode: "42501",
    });
    expect(classifyError({ code: "not-a-code" })).toEqual({
      errorClass: "worker_error",
      errorCode: null,
    });
  });

  it("falls back to worker_error", () => {
    expect(classifyError(new Error("raw secret"))).toEqual({
      errorClass: "worker_error",
      errorCode: null,
    });
  });
});

describe("jobErrorClass", () => {
  it("maps timeout and blocked targets", () => {
    expect(jobErrorClass(new CheckerError("timeout", SAFE_MESSAGES.timeout))).toBe(
      "timeout",
    );
    expect(
      jobErrorClass(new CheckerError("blocked_target", SAFE_MESSAGES.blocked_target)),
    ).toBe("blocked_target");
  });

  it("maps other failures to worker_error", () => {
    expect(jobErrorClass(new CheckerError("tls_error", SAFE_MESSAGES.tls_error))).toBe(
      "worker_error",
    );
    expect(jobErrorClass(new Error("unexpected"))).toBe("worker_error");
  });
});

describe("jobFailureDisposition", () => {
  it("retries transient timeout and transport failures", () => {
    expect(jobFailureDisposition(new CheckerError("timeout", SAFE_MESSAGES.timeout))).toEqual({
      errorClass: "timeout",
      retryable: true,
    });
    expect(jobFailureDisposition(new TransportError("connection_failure"))).toEqual({
      errorClass: "worker_error",
      retryable: true,
    });
  });

  it("dead-letters blocked targets immediately", () => {
    expect(
      jobFailureDisposition(
        new CheckerError("blocked_target", SAFE_MESSAGES.blocked_target),
      ),
    ).toEqual({ errorClass: "blocked_target", retryable: false });
  });

  it("does not retry unsupported monitor configuration", () => {
    expect(
      jobFailureDisposition(
        new CheckerError(
          "unsupported_configuration",
          SAFE_MESSAGES.unsupported_configuration,
        ),
      ),
    ).toEqual({ errorClass: "worker_error", retryable: false });
  });
});
