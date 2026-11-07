import {
  CHECK_ERROR_CLASSES,
  CHECK_STATUSES,
  SAFE_MESSAGES,
  type CheckErrorClass,
  type CheckResult,
  type CheckStatus,
} from "./index";

export class InvalidCheckerResultError extends Error {
  constructor() {
    super("checker returned an invalid result");
    this.name = "InvalidCheckerResultError";
  }
}

const CHECK_RESULT_FIELDS = [
  "status",
  "httpStatus",
  "responseTimeMs",
  "dnsMs",
  "connectMs",
  "tlsMs",
  "ttfbMs",
  "totalMs",
  "errorClass",
  "errorMessage",
  "redirects",
  "responseBytes",
  "checkedAt",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCheckerResultError();
  }
  return value as Record<string, unknown>;
}

function integer(
  value: unknown,
  min: number,
  max: number,
  nullable = false,
): number | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new InvalidCheckerResultError();
  }
  return value;
}

/**
 * Parses the small, fixed result shape returned by the checker process. The
 * result cannot carry a URL, hostname, header, body, monitor ID, organization
 * ID, or arbitrary error text. Error messages must be one of the fixed safe
 * messages for the reported error class.
 */
export function parseCheckResult(value: unknown): CheckResult {
  const input = record(value);

  const keys = Object.keys(input).sort();
  const allowed = [...CHECK_RESULT_FIELDS].sort();
  if (
    keys.length !== allowed.length ||
    keys.some((key, index) => key !== allowed[index])
  ) {
    throw new InvalidCheckerResultError();
  }

  const status = input.status;
  if (
    typeof status !== "string" ||
    !CHECK_STATUSES.includes(status as CheckStatus)
  ) {
    throw new InvalidCheckerResultError();
  }

  const httpStatus =
    input.httpStatus === null || input.httpStatus === undefined
      ? null
      : integer(input.httpStatus, 100, 599);

  const errorClass =
    input.errorClass === null || input.errorClass === undefined
      ? null
      : input.errorClass;
  if (
    errorClass !== null &&
    (typeof errorClass !== "string" ||
      !CHECK_ERROR_CLASSES.includes(errorClass as CheckErrorClass))
  ) {
    throw new InvalidCheckerResultError();
  }

  const errorMessage = input.errorMessage;
  if (
    errorClass === null
      ? errorMessage !== null
      : typeof errorMessage !== "string" ||
        errorMessage !== SAFE_MESSAGES[errorClass as CheckErrorClass]
  ) {
    throw new InvalidCheckerResultError();
  }

  if (status === "up" && errorClass !== null) {
    throw new InvalidCheckerResultError();
  }
  if (status !== "up" && errorClass === null) {
    throw new InvalidCheckerResultError();
  }

  const checkedAt = input.checkedAt;
  if (typeof checkedAt !== "string") throw new InvalidCheckerResultError();
  const checkedDate = new Date(checkedAt);
  if (
    Number.isNaN(checkedDate.getTime()) ||
    checkedDate.toISOString() !== checkedAt
  ) {
    throw new InvalidCheckerResultError();
  }

  return {
    status: status as CheckStatus,
    httpStatus,
    responseTimeMs: integer(input.responseTimeMs, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    dnsMs: integer(input.dnsMs, 0, Number.MAX_SAFE_INTEGER, true),
    connectMs: integer(input.connectMs, 0, Number.MAX_SAFE_INTEGER, true),
    tlsMs: integer(input.tlsMs, 0, Number.MAX_SAFE_INTEGER, true),
    ttfbMs: integer(input.ttfbMs, 0, Number.MAX_SAFE_INTEGER, true),
    totalMs: integer(input.totalMs, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    errorClass: errorClass as CheckErrorClass | null,
    errorMessage: errorMessage as string | null,
    redirects: integer(input.redirects, 0, 5) ?? 0,
    responseBytes: integer(
      input.responseBytes,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    checkedAt,
  };
}
