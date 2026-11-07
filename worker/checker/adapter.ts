import {
  CheckCancelledError,
  CheckerError,
  SAFE_MESSAGES,
  checkMonitor,
  type CheckMonitorOptions,
  type CheckResult,
  type MonitorCheckConfig,
} from "./index";

export interface WorkerChecker {
  check(config: MonitorCheckConfig, signal: AbortSignal): Promise<CheckResult>;
}

export class CustomerExecutionLockedError extends CheckerError {
  constructor() {
    super(
      "blocked_target",
      "Customer execution is NOT IMPLEMENTED in Phase 4B.",
    );
    this.name = "CustomerExecutionLockedError";
  }
}

export class InvalidFixtureError extends CheckerError {
  constructor() {
    super("blocked_target", SAFE_MESSAGES.blocked_target);
    this.name = "InvalidFixtureError";
  }
}

type CheckMonitorFn = (
  config: MonitorCheckConfig,
  options?: CheckMonitorOptions,
) => Promise<CheckResult>;

/**
 * Reuses the Phase 4A checker unchanged. Only the minimum monitor configuration
 * is passed in. This adapter is not wired into the production worker; the
 * production fixtures path runs behind a separate checker process.
 */
export function createRealChecker(
  dependencies: { checkMonitor?: CheckMonitorFn } = {},
): WorkerChecker {
  const run = dependencies.checkMonitor ?? checkMonitor;

  return {
    async check(config, signal) {
      return run(
        {
          url: config.url,
          method: config.method,
          expectedStatusCodes: [...config.expectedStatusCodes],
          timeoutSeconds: config.timeoutSeconds,
          verifyTls: config.verifyTls,
          followRedirects: config.followRedirects,
          maxRedirects: config.maxRedirects,
          hasRequestSecrets: config.hasRequestSecrets,
        },
        { signal },
      );
    },
  };
}

export type FixtureCheckerOptions = {
  /** Test seam: map a fixture URL to a deterministic result. */
  results?: Record<string, CheckResult>;
  now?: () => Date;
  /**
   * Exact fixture hostnames allowed by the worker. When supplied, a monitor
   * URL must match one of these names as well as ending in .test.
   */
  allowedHosts?: readonly string[];
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

function isAllowlistedFixtureHost(
  hostname: string,
  allowedHosts: readonly string[] | undefined,
): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (!hostname.endsWith(".test") || hostname.length <= ".test".length) {
    return false;
  }
  if (allowedHosts === undefined) return true;
  return allowedHosts.includes(hostname);
}

/**
 * Deterministic, network-free checker for local fixtures. It deliberately
 * refuses anything that is not an allowlisted .test host, even if a database
 * row is misconfigured. This is not a customer checker and cannot activate one.
 */
export function createFixtureChecker(
  options: FixtureCheckerOptions = {},
): WorkerChecker {
  const now = options.now ?? (() => new Date());

  return {
    async check(config, signal) {
      if (signal.aborted) throw new CheckCancelledError();

      let hostname: string;
      try {
        hostname = new URL(config.url).hostname.toLowerCase();
      } catch {
        throw new InvalidFixtureError();
      }
      if (!isAllowlistedFixtureHost(hostname, options.allowedHosts)) {
        throw new InvalidFixtureError();
      }

      const checkedAt = now();
      if (config.hasRequestSecrets) {
        return fixtureErrorResult("unsupported_configuration", checkedAt);
      }
      if (config.verifyTls !== true) {
        return fixtureErrorResult("unsupported_configuration", checkedAt);
      }
      if (config.method !== "GET" && config.method !== "HEAD") {
        return fixtureErrorResult("unsupported_configuration", checkedAt);
      }

      const override = options.results?.[config.url];
      if (override) {
        if (signal.aborted) throw new CheckCancelledError();
        return { ...override };
      }

      const simulatedStatus = config.expectedStatusCodes[0] ?? 200;
      const matched =
        config.expectedStatusCodes.length > 0 &&
        config.expectedStatusCodes.includes(simulatedStatus);
      const totalMs = 10;

      if (signal.aborted) throw new CheckCancelledError();

      return {
        status: matched ? "up" : "down",
        httpStatus: simulatedStatus,
        responseTimeMs: totalMs,
        dnsMs: 1,
        connectMs: 2,
        tlsMs: config.url.toLowerCase().startsWith("https:") ? 3 : null,
        ttfbMs: 4,
        totalMs,
        errorClass: matched ? null : "http_status_mismatch",
        errorMessage: matched ? null : SAFE_MESSAGES.http_status_mismatch,
        redirects: 0,
        responseBytes: config.method === "HEAD" ? 0 : 128,
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
