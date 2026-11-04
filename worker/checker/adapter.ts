import {
  CheckCancelledError,
  SAFE_MESSAGES,
  checkMonitor,
  type CheckMonitorOptions,
  type CheckResult,
  type MonitorCheckConfig,
} from "./index";
import type { ClaimedJob } from "../queue/queue-client";

export interface WorkerChecker {
  check(job: ClaimedJob, signal: AbortSignal): Promise<CheckResult>;
}

export class CustomerExecutionLockedError extends Error {
  constructor() {
    super("Customer execution is NOT IMPLEMENTED in Phase 4B.");
    this.name = "CustomerExecutionLockedError";
  }
}

export class InvalidFixtureError extends Error {
  constructor() {
    super("The fixture checker only supports local .test destinations.");
    this.name = "InvalidFixtureError";
  }
}

type CheckMonitorFn = (
  config: MonitorCheckConfig,
  options?: CheckMonitorOptions,
) => Promise<CheckResult>;

/**
 * Reuses the Phase 4A checker unchanged. Only the minimum monitor configuration
 * from the database is passed in. The checker process itself has no database
 * connection; this adapter runs inside the worker after a queue claim.
 */
export function createRealChecker(
  dependencies: { checkMonitor?: CheckMonitorFn } = {},
): WorkerChecker {
  const run = dependencies.checkMonitor ?? checkMonitor;

  return {
    async check(job, signal) {
      const config: MonitorCheckConfig = {
        url: job.url,
        method: job.method,
        expectedStatusCodes: job.expectedStatusCodes,
        timeoutSeconds: job.timeoutSeconds,
        verifyTls: job.verifyTls,
        followRedirects: job.followRedirects,
        maxRedirects: job.maxRedirects,
        hasRequestSecrets: job.hasRequestSecrets,
      };
      return run(config, { signal });
    },
  };
}

export type FixtureCheckerOptions = {
  /** Test seam: map a fixture URL to a deterministic result. */
  results?: Record<string, CheckResult>;
  now?: () => Date;
};

function fixtureErrorResult(
  errorClass: "unsupported_configuration" | "http_status_mismatch",
  now: Date,
): CheckResult {
  return {
    status: "error",
    httpStatus: null,
    responseTimeMs: 0,
    dnsMs: null,
    connectMs: null,
    tlsMs: null,
    ttfbMs: null,
    totalMs: 0,
    errorClass,
    errorMessage: SAFE_MESSAGES[errorClass],
    redirects: 0,
    responseBytes: null,
    checkedAt: now.toISOString(),
  };
}

/**
 * Deterministic, network-free checker for local fixtures. It deliberately
 * refuses anything that is not a .test host, even if a database row is
 * misconfigured. This is not a customer checker and cannot activate one.
 */
export function createFixtureChecker(
  options: FixtureCheckerOptions = {},
): WorkerChecker {
  const now = options.now ?? (() => new Date());

  return {
    async check(job, signal) {
      if (signal.aborted) throw new CheckCancelledError();

      let hostname: string;
      try {
        hostname = new URL(job.url).hostname.toLowerCase();
      } catch {
        throw new InvalidFixtureError();
      }
      if (!hostname.endsWith(".test")) {
        throw new InvalidFixtureError();
      }

      const checkedAt = now();
      if (job.hasRequestSecrets) {
        return fixtureErrorResult("unsupported_configuration", checkedAt);
      }
      if (job.verifyTls !== true) {
        return fixtureErrorResult("unsupported_configuration", checkedAt);
      }
      if (job.method !== "GET" && job.method !== "HEAD") {
        return fixtureErrorResult("unsupported_configuration", checkedAt);
      }

      const override = options.results?.[job.url];
      if (override) {
        if (signal.aborted) throw new CheckCancelledError();
        return { ...override };
      }

      const simulatedStatus = job.expectedStatusCodes[0] ?? 200;
      const matched =
        job.expectedStatusCodes.length > 0 &&
        job.expectedStatusCodes.includes(simulatedStatus);
      const totalMs = 10;

      if (signal.aborted) throw new CheckCancelledError();

      return {
        status: matched ? "up" : "down",
        httpStatus: simulatedStatus,
        responseTimeMs: totalMs,
        dnsMs: 1,
        connectMs: 2,
        tlsMs: job.url.toLowerCase().startsWith("https:") ? 3 : null,
        ttfbMs: 4,
        totalMs,
        errorClass: matched ? null : "http_status_mismatch",
        errorMessage: matched ? null : SAFE_MESSAGES.http_status_mismatch,
        redirects: 0,
        responseBytes: job.method === "HEAD" ? 0 : 128,
        checkedAt: checkedAt.toISOString(),
      };
    },
  };
}

export function createLockedChecker(): WorkerChecker {
  return {
    async check() {
      throw new CustomerExecutionLockedError();
    },
  };
}
