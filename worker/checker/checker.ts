import { performance } from "node:perf_hooks";
import {
  CheckCancelledError,
  CheckTimeoutError,
  CheckerError,
  RedirectError,
  SAFE_MESSAGES,
  TransportError,
  UnsupportedConfigurationError,
  type CheckErrorClass,
  type CheckStatus,
} from "./errors";
import {
  createSystemDnsResolver,
  resolveDestination,
  type DnsResolver,
} from "./destination";
import { resolveCheckerLimits, type CheckerLimits } from "./limits";
import {
  createUndiciTransport,
  type CheckerMethod,
  type HttpTransport,
} from "./transport";
import {
  parseRedirectTarget,
  validateTargetUrl,
  type ValidatedTarget,
} from "./url-policy";

export type MonitorCheckConfig = {
  url: string;
  method: string;
  expectedStatusCodes: readonly number[];
  timeoutSeconds: number;
  /** TLS verification is always required. False is rejected. */
  verifyTls?: boolean;
  followRedirects?: boolean;
  maxRedirects?: number;
  expectedBodyText?: string | null;
  expectedBodyIsRegex?: boolean;
  /** Set when a monitor_request_secrets row exists. Phase 4A cannot apply it. */
  hasRequestSecrets?: boolean;
};

export type CheckResult = {
  status: CheckStatus;
  httpStatus: number | null;
  responseTimeMs: number;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  totalMs: number;
  errorClass: CheckErrorClass | null;
  errorMessage: string | null;
  redirects: number;
  /** Body bytes read and discarded. Never persisted as a body. */
  responseBytes: number | null;
  checkedAt: string;
};

export type CheckMonitorOptions = {
  dnsResolver?: DnsResolver;
  transport?: HttpTransport;
  /** Test seam only; ceilings are still enforced by resolveCheckerLimits. */
  limits?: Partial<CheckerLimits>;
  signal?: AbortSignal;
  now?: () => number;
};

type NormalizedConfig = {
  target: ValidatedTarget;
  method: CheckerMethod;
  expectedStatusCodes: number[];
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function roundMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function normalizeConfig(
  config: MonitorCheckConfig,
  limits: CheckerLimits,
): NormalizedConfig {
  if (
    config.hasRequestSecrets !== undefined &&
    config.hasRequestSecrets !== false
  ) {
    throw new UnsupportedConfigurationError();
  }
  if (
    config.expectedBodyText !== null &&
    config.expectedBodyText !== undefined
  ) {
    throw new UnsupportedConfigurationError();
  }
  if (
    config.expectedBodyIsRegex !== undefined &&
    config.expectedBodyIsRegex !== false
  ) {
    throw new UnsupportedConfigurationError();
  }
  if (config.verifyTls !== undefined && config.verifyTls !== true) {
    throw new UnsupportedConfigurationError();
  }

  if (typeof config.method !== "string") {
    throw new UnsupportedConfigurationError();
  }
  const method = config.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new UnsupportedConfigurationError();
  }

  if (
    typeof config.timeoutSeconds !== "number" ||
    !Number.isInteger(config.timeoutSeconds)
  ) {
    throw new UnsupportedConfigurationError();
  }
  const timeoutMs = config.timeoutSeconds * 1000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < limits.minTimeoutMs ||
    timeoutMs > limits.maxTimeoutMs
  ) {
    throw new UnsupportedConfigurationError();
  }

  if (
    !Array.isArray(config.expectedStatusCodes) ||
    config.expectedStatusCodes.length === 0 ||
    config.expectedStatusCodes.length > limits.maxStatusCodes
  ) {
    throw new UnsupportedConfigurationError();
  }

  const expectedStatusCodes = [
    ...new Set(config.expectedStatusCodes),
  ].sort((a, b) => a - b);

  if (
    expectedStatusCodes.some(
      (code) => !Number.isInteger(code) || code < 100 || code > 599,
    )
  ) {
    throw new UnsupportedConfigurationError();
  }

  if (
    config.followRedirects !== undefined &&
    typeof config.followRedirects !== "boolean"
  ) {
    throw new UnsupportedConfigurationError();
  }

  const followRedirects = config.followRedirects === true;
  let maxRedirects = 0;

  if (followRedirects) {
    if (
      typeof config.maxRedirects !== "number" ||
      !Number.isInteger(config.maxRedirects) ||
      config.maxRedirects < 1 ||
      config.maxRedirects > limits.maxRedirects
    ) {
      throw new UnsupportedConfigurationError();
    }
    maxRedirects = config.maxRedirects;
  } else if (
    config.maxRedirects !== undefined &&
    config.maxRedirects !== 0
  ) {
    throw new UnsupportedConfigurationError();
  }

  const target = validateTargetUrl(config.url, limits);

  return {
    target,
    method,
    expectedStatusCodes,
    timeoutMs,
    followRedirects,
    maxRedirects,
  };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new CheckCancelledError());
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new CheckCancelledError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function errorClassFor(error: unknown): {
  errorClass: CheckErrorClass;
  message: string;
} {
  if (error instanceof CheckerError) {
    return { errorClass: error.errorClass, message: error.safeMessage };
  }
  if (error instanceof TransportError) {
    if (error.kind === "aborted") {
      return {
        errorClass: "internal_error",
        message: SAFE_MESSAGES.internal_error,
      };
    }
    return { errorClass: error.kind, message: error.safeMessage };
  }
  if (error instanceof CheckTimeoutError) {
    return { errorClass: "timeout", message: SAFE_MESSAGES.timeout };
  }
  return {
    errorClass: "internal_error",
    message: SAFE_MESSAGES.internal_error,
  };
}

/**
 * Runs one bounded check and returns a sanitized result. It never throws for a
 * failed check; cancellation is the only exception, and it is not a result.
 */
export async function checkMonitor(
  config: MonitorCheckConfig,
  options: CheckMonitorOptions = {},
): Promise<CheckResult> {
  if (options.signal?.aborted) {
    throw new CheckCancelledError();
  }

  const limits = resolveCheckerLimits(options.limits);
  const started = performance.now();
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();

  let dnsMeasured = false;
  let connectMeasured = false;
  let tlsMeasured = false;
  let ttfbMeasured = false;
  const timings = {
    dnsMs: 0,
    connectMs: 0,
    tlsMs: 0,
    ttfbMs: 0,
  };

  let httpStatus: number | null = null;
  let responseBytes: number | null = null;
  let redirects = 0;

  const result = (
    status: CheckStatus,
    errorClass: CheckErrorClass | null,
    errorMessage: string | null,
  ): CheckResult => {
    const totalMs = roundMs(performance.now() - started);
    return {
      status,
      httpStatus,
      responseTimeMs: totalMs,
      dnsMs: dnsMeasured ? roundMs(timings.dnsMs) : null,
      connectMs: connectMeasured ? roundMs(timings.connectMs) : null,
      tlsMs: tlsMeasured ? roundMs(timings.tlsMs) : null,
      ttfbMs: ttfbMeasured ? roundMs(timings.ttfbMs) : null,
      totalMs,
      errorClass,
      errorMessage,
      redirects,
      responseBytes,
      checkedAt,
    };
  };

  let normalized: NormalizedConfig;
  try {
    normalized = normalizeConfig(config, limits);
  } catch (error) {
    const classified = errorClassFor(error);
    return result("error", classified.errorClass, classified.message);
  }

  const controller = new AbortController();
  const timeoutTimer = setTimeout(
    () => controller.abort(new CheckTimeoutError()),
    normalized.timeoutMs,
  );
  const onExternalAbort = () => controller.abort(new CheckCancelledError());

  if (options.signal) {
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal.aborted) {
      onExternalAbort();
    }
  }

  const resolver = options.dnsResolver ?? createSystemDnsResolver();
  const transport = options.transport ?? createUndiciTransport();
  const visited = new Set<string>([normalized.target.canonical]);
  let current = normalized.target;

  try {
    while (true) {
      const remainingMs = normalized.timeoutMs - (performance.now() - started);
      if (remainingMs <= 0) {
        throw new CheckTimeoutError();
      }

      const destination = await withAbort(
        resolveDestination(current, {
          resolver,
          signal: controller.signal,
          dnsTimeoutMs: Math.min(remainingMs, limits.dnsTimeoutMs),
        }),
        controller.signal,
      );

      dnsMeasured = true;
      timings.dnsMs += destination.dnsMs;

      const remainingForRequest =
        normalized.timeoutMs - (performance.now() - started);
      if (remainingForRequest <= 0) {
        throw new CheckTimeoutError();
      }

      const response = await withAbort(
        transport.request({
          url: current.url,
          method: normalized.method,
          pinnedAddress: destination.pinned,
          tlsServername: current.isIpLiteral ? null : current.hostname,
          timeoutMs: Math.max(1, Math.floor(remainingForRequest)),
          connectTimeoutMs: Math.max(
            1,
            Math.min(
              Math.floor(remainingForRequest),
              limits.connectTimeoutMs,
            ),
          ),
          maxResponseBytes: limits.maxResponseBytes,
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (response.timings.connectMs !== null) {
        connectMeasured = true;
        timings.connectMs += response.timings.connectMs;
      }
      if (response.timings.tlsMs !== null) {
        tlsMeasured = true;
        timings.tlsMs += response.timings.tlsMs;
      }
      ttfbMeasured = true;
      timings.ttfbMs += response.timings.ttfbMs;

      httpStatus = response.statusCode;
      responseBytes = response.bytesRead;

      if (
        normalized.followRedirects &&
        REDIRECT_STATUSES.has(response.statusCode)
      ) {
        if (redirects >= normalized.maxRedirects) {
          throw new RedirectError("redirect_loop");
        }
        if (!response.location) {
          throw new RedirectError("redirect_failure");
        }

        const next = parseRedirectTarget(
          response.location,
          current.url,
          limits,
        );

        if (visited.has(next.canonical)) {
          throw new RedirectError("redirect_loop");
        }

        visited.add(next.canonical);
        redirects += 1;
        current = next;
        continue;
      }

      if (normalized.expectedStatusCodes.includes(response.statusCode)) {
        return result("up", null, null);
      }

      return result(
        "down",
        "http_status_mismatch",
        SAFE_MESSAGES.http_status_mismatch,
      );
    }
  } catch (error) {
    if (error instanceof CheckCancelledError) {
      throw error;
    }

    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof CheckCancelledError) {
        throw reason;
      }
      if (reason instanceof CheckTimeoutError) {
        return result("error", "timeout", SAFE_MESSAGES.timeout);
      }
    }

    if (error instanceof CheckTimeoutError) {
      return result("error", "timeout", SAFE_MESSAGES.timeout);
    }

    if (error instanceof TransportError && error.kind === "aborted") {
      if (options.signal?.aborted) {
        throw new CheckCancelledError();
      }
      return result("error", "internal_error", SAFE_MESSAGES.internal_error);
    }

    const classified = errorClassFor(error);
    return result("error", classified.errorClass, classified.message);
  } finally {
    clearTimeout(timeoutTimer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
