/**
 * Server-enforced checker limits.
 *
 * These are worker limits, not customer settings. A monitor may request a
 * shorter timeout, but it can never exceed the values here. There is no
 * environment flag or monitor field that raises these ceilings.
 */

export type CheckerLimits = {
  minTimeoutMs: number;
  maxTimeoutMs: number;
  connectTimeoutMs: number;
  dnsTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  /** Maximum validated addresses tried for one hostname before giving up. */
  maxAddressAttempts: number;
  maxConcurrency: number;
  maxUrlLength: number;
  maxStatusCodes: number;
};

/** Absolute ceilings. Test overrides may lower these, never raise them. */
export const CHECKER_LIMITS: Readonly<CheckerLimits> = Object.freeze({
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  connectTimeoutMs: 10_000,
  dnsTimeoutMs: 5_000,
  maxResponseBytes: 1_048_576,
  maxRedirects: 5,
  maxAddressAttempts: 3,
  maxConcurrency: 10,
  maxUrlLength: 2_048,
  maxStatusCodes: 20,
});

export const CHECKER_USER_AGENT = "OneDash-Checker/0.1";

function positiveInteger(
  value: number,
  name: keyof CheckerLimits,
  ceiling: number,
): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return Math.min(value, ceiling);
}

/**
 * Applies test overrides while preserving the server ceilings. A caller can
 * lower a limit for a deterministic test, but cannot raise it above the
 * production maximum.
 */
export function resolveCheckerLimits(
  overrides: Partial<CheckerLimits> = {},
): CheckerLimits {
  const merged: CheckerLimits = { ...CHECKER_LIMITS, ...overrides };

  const minTimeoutMs = positiveInteger(
    merged.minTimeoutMs,
    "minTimeoutMs",
    CHECKER_LIMITS.minTimeoutMs,
  );
  const maxTimeoutMs = positiveInteger(
    merged.maxTimeoutMs,
    "maxTimeoutMs",
    CHECKER_LIMITS.maxTimeoutMs,
  );
  if (minTimeoutMs > maxTimeoutMs) {
    throw new RangeError("minTimeoutMs cannot exceed maxTimeoutMs");
  }

  return {
    minTimeoutMs,
    maxTimeoutMs,
    connectTimeoutMs: positiveInteger(
      merged.connectTimeoutMs,
      "connectTimeoutMs",
      CHECKER_LIMITS.connectTimeoutMs,
    ),
    dnsTimeoutMs: positiveInteger(
      merged.dnsTimeoutMs,
      "dnsTimeoutMs",
      CHECKER_LIMITS.dnsTimeoutMs,
    ),
    maxResponseBytes: positiveInteger(
      merged.maxResponseBytes,
      "maxResponseBytes",
      CHECKER_LIMITS.maxResponseBytes,
    ),
    maxRedirects: positiveInteger(
      merged.maxRedirects,
      "maxRedirects",
      CHECKER_LIMITS.maxRedirects,
    ),
    maxAddressAttempts: positiveInteger(
      merged.maxAddressAttempts,
      "maxAddressAttempts",
      CHECKER_LIMITS.maxAddressAttempts,
    ),
    maxConcurrency: positiveInteger(
      merged.maxConcurrency,
      "maxConcurrency",
      CHECKER_LIMITS.maxConcurrency,
    ),
    maxUrlLength: positiveInteger(
      merged.maxUrlLength,
      "maxUrlLength",
      CHECKER_LIMITS.maxUrlLength,
    ),
    maxStatusCodes: positiveInteger(
      merged.maxStatusCodes,
      "maxStatusCodes",
      CHECKER_LIMITS.maxStatusCodes,
    ),
  };
}
