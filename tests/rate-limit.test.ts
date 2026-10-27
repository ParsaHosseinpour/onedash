import { beforeEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  resetRateLimitsForTests,
} from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimitsForTests();
  });

  it("allows requests up to the limit", () => {
    const key = "test:allow";
    const now = 1_000_000;

    expect(checkRateLimit(key, 2, 60_000, now)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(checkRateLimit(key, 2, 60_000, now + 1)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("blocks requests over the limit and reports a retry time", () => {
    const key = "test:block";
    const now = 2_000_000;

    checkRateLimit(key, 1, 60_000, now);
    const decision = checkRateLimit(key, 1, 60_000, now + 10_000);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(50_000);
  });

  it("starts a fresh window after the old one expires", () => {
    const key = "test:window";
    const now = 3_000_000;

    checkRateLimit(key, 1, 60_000, now);
    expect(checkRateLimit(key, 1, 60_000, now + 60_001).allowed).toBe(true);
  });

  it("fails closed for invalid limits", () => {
    expect(checkRateLimit("test:invalid", 0, 60_000).allowed).toBe(false);
    expect(checkRateLimit("test:invalid", 1, 0).allowed).toBe(false);
  });
});
