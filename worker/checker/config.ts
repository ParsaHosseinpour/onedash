import type { MonitorCheckConfig } from "./checker";
import type { ClaimedJob } from "../queue/queue-client";

/**
 * The complete set of monitor fields a checker is allowed to receive.
 *
 * Lease tokens, job IDs, monitor IDs, organization IDs, database URLs, and
 * service-role keys are deliberately absent. The checker process must never
 * need them.
 */
const CHECKER_CONFIG_FIELDS = [
  "url",
  "method",
  "expectedStatusCodes",
  "timeoutSeconds",
  "verifyTls",
  "followRedirects",
  "maxRedirects",
  "hasRequestSecrets",
] as const;

export class InvalidCheckerConfigError extends Error {
  constructor() {
    super("checker received fields outside the minimal monitor configuration");
    this.name = "InvalidCheckerConfigError";
  }
}

export function toMonitorCheckConfig(job: ClaimedJob): MonitorCheckConfig {
  return {
    url: job.url,
    method: job.method,
    expectedStatusCodes: [...job.expectedStatusCodes],
    timeoutSeconds: job.timeoutSeconds,
    verifyTls: job.verifyTls,
    followRedirects: job.followRedirects,
    maxRedirects: job.maxRedirects,
    hasRequestSecrets: job.hasRequestSecrets,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strict wire parser for the checker process. Unknown fields are rejected
 * instead of copied, so a caller cannot smuggle a lease token or database
 * credential into the isolated process.
 */
export function parseMonitorCheckConfig(value: unknown): MonitorCheckConfig {
  if (!isRecord(value)) throw new InvalidCheckerConfigError();

  const keys = Object.keys(value).sort();
  const allowed = [...CHECKER_CONFIG_FIELDS].sort();
  if (
    keys.length !== allowed.length ||
    keys.some((key, index) => key !== allowed[index])
  ) {
    throw new InvalidCheckerConfigError();
  }

  const url = value.url;
  const method = value.method;
  const expectedStatusCodes = value.expectedStatusCodes;
  const timeoutSeconds = value.timeoutSeconds;
  const verifyTls = value.verifyTls;
  const followRedirects = value.followRedirects;
  const maxRedirects = value.maxRedirects;
  const hasRequestSecrets = value.hasRequestSecrets;

  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    throw new InvalidCheckerConfigError();
  }
  if (typeof method !== "string" || (method !== "GET" && method !== "HEAD")) {
    throw new InvalidCheckerConfigError();
  }
  if (
    !Array.isArray(expectedStatusCodes) ||
    expectedStatusCodes.length === 0 ||
    expectedStatusCodes.length > 20 ||
    expectedStatusCodes.some(
      (code) => !Number.isInteger(code) || code < 100 || code > 599,
    )
  ) {
    throw new InvalidCheckerConfigError();
  }
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 60
  ) {
    throw new InvalidCheckerConfigError();
  }
  if (typeof verifyTls !== "boolean") throw new InvalidCheckerConfigError();
  if (typeof followRedirects !== "boolean") throw new InvalidCheckerConfigError();
  if (
    typeof maxRedirects !== "number" ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 5
  ) {
    throw new InvalidCheckerConfigError();
  }
  if (typeof hasRequestSecrets !== "boolean") {
    throw new InvalidCheckerConfigError();
  }

  return {
    url,
    method,
    expectedStatusCodes: [...new Set(expectedStatusCodes)],
    timeoutSeconds,
    verifyTls,
    followRedirects,
    maxRedirects,
    hasRequestSecrets,
  };
}
