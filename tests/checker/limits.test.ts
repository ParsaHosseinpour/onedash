import { describe, expect, it } from "vitest";
import {
  CHECKER_LIMITS,
  resolveCheckerLimits,
} from "../../worker/checker/limits";

describe("checker limits", () => {
  it("allows tests to lower every ceiling", () => {
    const lowered = resolveCheckerLimits({
      minTimeoutMs: 100,
      maxTimeoutMs: 2_000,
      connectTimeoutMs: 500,
      dnsTimeoutMs: 500,
      maxResponseBytes: 10,
      maxRedirects: 2,
      maxAddressAttempts: 2,
      maxConcurrency: 2,
      maxUrlLength: 1_024,
      maxStatusCodes: 5,
    });

    expect(lowered).toEqual({
      minTimeoutMs: 100,
      maxTimeoutMs: 2_000,
      connectTimeoutMs: 500,
      dnsTimeoutMs: 500,
      maxResponseBytes: 10,
      maxRedirects: 2,
      maxAddressAttempts: 2,
      maxConcurrency: 2,
      maxUrlLength: 1_024,
      maxStatusCodes: 5,
    });
  });

  it("cannot raise a limit above the production ceiling", () => {
    const raised = resolveCheckerLimits({
      minTimeoutMs: 60_000,
      maxTimeoutMs: 60_000,
      connectTimeoutMs: 60_000,
      dnsTimeoutMs: 60_000,
      maxResponseBytes: 10_485_760,
      maxRedirects: 10,
      maxConcurrency: 100,
      maxUrlLength: 8_192,
      maxStatusCodes: 100,
    });

    expect(raised).toEqual(CHECKER_LIMITS);
  });

  it("rejects non-positive and non-integer overrides", () => {
    expect(() => resolveCheckerLimits({ maxResponseBytes: 0 })).toThrow(
      RangeError,
    );
    expect(() => resolveCheckerLimits({ maxConcurrency: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      resolveCheckerLimits({ minTimeoutMs: 1_000, maxTimeoutMs: 500 }),
    ).toThrow(RangeError);
  });
});
