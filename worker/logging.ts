import {
  CheckCancelledError,
  CheckTimeoutError,
  CheckerError,
  TransportError,
} from "./checker";

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
  "host",
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

export function sanitizeReason(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 60) || "unknown";
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

export function jobErrorClass(
  error: unknown,
): "timeout" | "blocked_target" | "worker_error" {
  if (error instanceof CheckTimeoutError) return "timeout";
  if (error instanceof CheckerError) {
    if (error.errorClass === "timeout") return "timeout";
    if (error.errorClass === "blocked_target") return "blocked_target";
  }
  if (error instanceof TransportError && error.kind === "timeout") {
    return "timeout";
  }
  return "worker_error";
}
