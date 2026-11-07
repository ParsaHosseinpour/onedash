import { describe, expect, it } from "vitest";
import type { CheckResult } from "../../worker/checker";
import {
  InvalidCheckResultError,
  toIngestPayload,
} from "../../worker/ingestor/result-payload";

function validResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    status: "up",
    httpStatus: 200,
    responseTimeMs: 120,
    dnsMs: 4,
    connectMs: 8,
    tlsMs: 12,
    ttfbMs: 20,
    totalMs: 130,
    errorClass: null,
    errorMessage: null,
    redirects: 0,
    responseBytes: 512,
    checkedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

describe("toIngestPayload", () => {
  it("maps a successful result to the exact ingestion shape", () => {
    const payload = toIngestPayload(validResult());

    expect(payload).toEqual({
      status: "up",
      http_status: 200,
      response_time_ms: 120,
      dns_ms: 4,
      connect_ms: 8,
      tls_ms: 12,
      ttfb_ms: 20,
      total_ms: 130,
      error_class: null,
      error_message: null,
      redirect_count: 0,
      response_bytes: 512,
      checked_at: "2026-01-02T03:04:05.000Z",
    });
    expect(Object.keys(payload).sort()).toEqual(
      [
        "status",
        "http_status",
        "response_time_ms",
        "dns_ms",
        "connect_ms",
        "tls_ms",
        "ttfb_ms",
        "total_ms",
        "error_class",
        "error_message",
        "redirect_count",
        "response_bytes",
        "checked_at",
      ].sort(),
    );
    expect(payload).not.toHaveProperty("url");
    expect(payload).not.toHaveProperty("monitorId");
    expect(payload).not.toHaveProperty("organizationId");
    expect(payload).not.toHaveProperty("idempotencyKey");
  });

  it("maps a failed result with its safe error class", () => {
    const payload = toIngestPayload(
      validResult({
        status: "down",
        httpStatus: 503,
        errorClass: "http_status_mismatch",
        errorMessage: "The response status did not match the expected status.",
      }),
    );
    expect(payload.status).toBe("down");
    expect(payload.http_status).toBe(503);
    expect(payload.error_class).toBe("http_status_mismatch");
  });

  it("rejects invalid statuses", () => {
    expect(() =>
      toIngestPayload(validResult({ status: "unknown" as never })),
    ).toThrow(InvalidCheckResultError);
  });

  it("rejects invalid timestamps", () => {
    expect(() =>
      toIngestPayload(validResult({ checkedAt: "not-a-date" })),
    ).toThrow(/checkedAt/);
  });

  it("rejects negative timings and invalid HTTP status", () => {
    expect(() =>
      toIngestPayload(validResult({ totalMs: -1 })),
    ).toThrow(/totalMs/);
    expect(() =>
      toIngestPayload(validResult({ httpStatus: 99 })),
    ).toThrow(/httpStatus/);
  });

  it("rejects inconsistent error classes", () => {
    expect(() =>
      toIngestPayload(
        validResult({ errorClass: "timeout", errorMessage: "The check timed out." }),
      ),
    ).toThrow(/errorClass/);
    expect(() =>
      toIngestPayload(validResult({ status: "down", errorClass: null })),
    ).toThrow(/errorClass/);
  });

  it("rejects too many redirects and oversized error messages", () => {
    expect(() => toIngestPayload(validResult({ redirects: 6 }))).toThrow(
      /redirects/,
    );
    expect(() =>
      toIngestPayload(
        validResult({
          status: "down",
          errorClass: "internal_error",
          errorMessage: "x".repeat(1001),
        }),
      ),
    ).toThrow(/errorMessage/);
  });

  it("accepts only the fixed safe message for an error class", () => {
    expect(
      toIngestPayload(
        validResult({
          status: "down",
          errorClass: "timeout",
          errorMessage: "The check timed out.",
        }),
      ),
    ).toMatchObject({
      status: "down",
      error_class: "timeout",
      error_message: "The check timed out.",
    });

    for (const errorMessage of [
      "timeout at https://customer.example/private",
      "The destination timed out.",
      "",
    ]) {
      expect(() =>
        toIngestPayload(
          validResult({
            status: "down",
            errorClass: "timeout",
            errorMessage,
          }),
        ),
      ).toThrow(/errorMessage/);
    }
  });

  it("rejects an error message on a successful result", () => {
    expect(() =>
      toIngestPayload(
        validResult({ errorMessage: "leaked https://customer.example" }),
      ),
    ).toThrow(/errorMessage/);
  });

  it("rejects a failed result without an error class", () => {
    expect(() =>
      toIngestPayload(
        validResult({
          status: "error",
          errorClass: null,
          errorMessage: null,
        }),
      ),
    ).toThrow(/errorClass/);
  });
});
