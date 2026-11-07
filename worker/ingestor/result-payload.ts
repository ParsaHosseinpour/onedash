import {
  CHECK_ERROR_CLASSES,
  CHECK_STATUSES,
  SAFE_MESSAGES,
  type CheckErrorClass,
  type CheckResult,
  type CheckStatus,
} from "../checker";

export type IngestCheckResult = {
  status: CheckStatus;
  http_status: number | null;
  response_time_ms: number;
  dns_ms: number | null;
  connect_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  total_ms: number;
  error_class: CheckErrorClass | null;
  error_message: string | null;
  redirect_count: number;
  response_bytes: number | null;
  checked_at: string;
};

export class InvalidCheckResultError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`invalid check result field: ${field}`);
    this.name = "InvalidCheckResultError";
    this.field = field;
  }
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidCheckResultError(field);
  }
  return Math.round(value);
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(value, field);
}

/**
 * Converts the Phase 4A checker result into the exact payload accepted by the
 * restricted ingestion function. The payload cannot contain a monitor ID,
 * organization ID, URL, region, or idempotency key; the database job row is
 * the sole authority for those values.
 */
export function toIngestPayload(result: CheckResult): IngestCheckResult {
  if (!CHECK_STATUSES.includes(result.status)) {
    throw new InvalidCheckResultError("status");
  }

  const checkedAt = new Date(result.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) {
    throw new InvalidCheckResultError("checkedAt");
  }

  const httpStatus =
    result.httpStatus === null
      ? null
      : nonNegativeInteger(result.httpStatus, "httpStatus");
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) {
    throw new InvalidCheckResultError("httpStatus");
  }

  const errorClass = result.errorClass;
  if (
    errorClass !== null &&
    !CHECK_ERROR_CLASSES.includes(errorClass as CheckErrorClass)
  ) {
    throw new InvalidCheckResultError("errorClass");
  }
  if (result.status === "up" && errorClass !== null) {
    throw new InvalidCheckResultError("errorClass");
  }
  if (result.status !== "up" && errorClass === null) {
    throw new InvalidCheckResultError("errorClass");
  }

  const errorMessage = result.errorMessage;
  if (errorClass === null) {
    if (errorMessage !== null) {
      throw new InvalidCheckResultError("errorMessage");
    }
  } else if (errorMessage !== SAFE_MESSAGES[errorClass]) {
    // The database accepts only the fixed checker vocabulary. Free-form error
    // text can contain a hostname, response body, or header value.
    throw new InvalidCheckResultError("errorMessage");
  }

  const redirectCount = nonNegativeInteger(result.redirects, "redirects");
  if (redirectCount > 5) {
    throw new InvalidCheckResultError("redirects");
  }

  return {
    status: result.status,
    http_status: httpStatus,
    response_time_ms: nonNegativeInteger(result.responseTimeMs, "responseTimeMs"),
    dns_ms: nullableNonNegativeInteger(result.dnsMs, "dnsMs"),
    connect_ms: nullableNonNegativeInteger(result.connectMs, "connectMs"),
    tls_ms: nullableNonNegativeInteger(result.tlsMs, "tlsMs"),
    ttfb_ms: nullableNonNegativeInteger(result.ttfbMs, "ttfbMs"),
    total_ms: nonNegativeInteger(result.totalMs, "totalMs"),
    error_class: errorClass,
    error_message: errorMessage,
    redirect_count: redirectCount,
    response_bytes: nullableNonNegativeInteger(result.responseBytes, "responseBytes"),
    checked_at: checkedAt.toISOString(),
  };
}
