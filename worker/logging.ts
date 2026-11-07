import {
  CheckCancelledError,
  CheckTimeoutError,
  CheckerError,
  TransportError,
} from "./checker";
import type { JobErrorClass } from "./queue/queue-client";

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

const LOG_LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LOG_LEVEL_ORDER;

/**
 * Log field allowlist. Customer URLs, hostnames, monitor IDs, organization
 * IDs, request headers, request secrets, alert secrets, and raw error messages
 * are deliberately absent. A caller cannot accidentally add one.
 */
const ALLOWED_FIELDS = new Set([
  "component",
  "workerId",
  "schedulerId",
  "region",
  "jobId",
  "attempt",
  "maxAttempts",
  "status",
  "errorClass",
  "errorCode",
  "durationMs",
  "retryAt",
  "inFlight",
  "concurrency",
  "claimed",
  "completed",
  "failed",
  "retried",
  "released",
  "reaped",
  "deadLettered",
  "scheduled",
  "skipped",
  "executionMode",
  "dbExecutionMode",
  "mode",
  "port",
  "queueDepth",
  "oldestJobAgeSeconds",
  "schedulerDelaySeconds",
  "schedulerHeartbeatAgeSeconds",
  "workerHeartbeatAgeSeconds",
  "workerConcurrency",
  "timeoutResultsLastHour",
  "checkDurationMsAvgLastHour",
  "fixtureHostCount",
  "reason",
  "duplicate",
  "queueMetricsError",
]);

/**
 * Reasons are fixed operational codes, not user text. Anything that could be a
 * URL, hostname, email address, filesystem path, or free-form message is
 * replaced wholesale so a hostname cannot survive sanitisation.
 */
export function sanitizeReason(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  if (!/^[A-Za-z0-9_:-]{1,60}$/.test(trimmed)) return "redacted";
  return trimmed;
}

function sanitizeErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Z0-9]{5}$/.test(value) ? value : null;
}

function primitive(value: unknown, key: string): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (key === "reason") return sanitizeReason(value);
    if (key === "errorCode") return sanitizeErrorCode(value) ?? undefined;
    return value.slice(0, 200);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value;
  return undefined;
}

export function createJsonLogger(options: {
  level?: Level;
  sink?: (line: string) => void;
  now?: () => Date;
} = {}): Logger {
  const level = options.level ?? "info";
  const sink =
    options.sink ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? (() => new Date());

  const write = (entryLevel: Level, event: string, fields: LogFields = {}) => {
    if (LOG_LEVEL_ORDER[entryLevel] < LOG_LEVEL_ORDER[level]) return;

    const entry: Record<string, unknown> = {
      time: now().toISOString(),
      level: entryLevel,
      event: /^[a-z0-9_]{1,64}$/.test(event) ? event : "log",
    };

    for (const [key, raw] of Object.entries(fields)) {
      if (!ALLOWED_FIELDS.has(key)) continue;
      const value = primitive(raw, key);
      if (value !== undefined) entry[key] = value;
    }

    try {
      sink(JSON.stringify(entry));
    } catch {
      // Logging must never take down the worker. Do not retry with raw values.
    }
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export function createSilentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

export function classifyError(error: unknown): {
  errorClass: string;
  errorCode: string | null;
} {
  if (error instanceof CheckCancelledError) {
    return { errorClass: "cancelled", errorCode: null };
  }
  if (error instanceof CheckTimeoutError) {
    return { errorClass: "timeout", errorCode: null };
  }
  if (error instanceof CheckerError) {
    return { errorClass: error.errorClass, errorCode: null };
  }
  if (error instanceof TransportError) {
    return {
      errorClass: error.kind === "aborted" ? "cancelled" : error.kind,
      errorCode: null,
    };
  }
  if (error && typeof error === "object" && "code" in error) {
    return {
      errorClass: "worker_error",
      errorCode: sanitizeErrorCode((error as { code?: unknown }).code),
    };
  }
  return { errorClass: "worker_error", errorCode: null };
}

export type JobFailureDisposition = {
  errorClass: JobErrorClass;
  retryable: boolean;
};

/**
 * Explicit retry policy. Transient transport, process, and internal failures
 * retry with backoff. A blocked target is an authorization decision and is
 * dead-lettered immediately. Unsupported configuration is also permanent for
 * the current monitor version and must not consume five retry attempts.
 */
export function jobFailureDisposition(error: unknown): JobFailureDisposition {
  if (error instanceof CheckTimeoutError) {
    return { errorClass: "timeout", retryable: true };
  }
  if (error instanceof CheckerError) {
    if (error.errorClass === "timeout") {
      return { errorClass: "timeout", retryable: true };
    }
    if (error.errorClass === "blocked_target") {
      return { errorClass: "blocked_target", retryable: false };
    }
    if (error.errorClass === "unsupported_configuration") {
      return { errorClass: "worker_error", retryable: false };
    }
    return { errorClass: "worker_error", retryable: true };
  }
  if (error instanceof TransportError) {
    return {
      errorClass: error.kind === "timeout" ? "timeout" : "worker_error",
      retryable: true,
    };
  }
  return { errorClass: "worker_error", retryable: true };
}

/** Backwards-compatible error-class-only view of the retry policy. */
export function jobErrorClass(error: unknown): JobErrorClass {
  return jobFailureDisposition(error).errorClass;
}
