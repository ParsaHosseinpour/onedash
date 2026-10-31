/**
 * Error vocabulary shared by the checker, its transport, and future result
 * ingestion. Every class maps to a database `check_results.error_class` value;
 * raw error messages are never surfaced or logged.
 */

export const CHECK_ERROR_CLASSES = [
  "dns_failure",
  "connection_refused",
  "connection_failure",
  "timeout",
  "tls_error",
  "http_status_mismatch",
  "body_mismatch",
  "redirect_loop",
  "redirect_failure",
  "blocked_target",
  "response_too_large",
  "unsupported_configuration",
  "internal_error",
  "latency_threshold",
] as const;

export type CheckErrorClass = (typeof CHECK_ERROR_CLASSES)[number];

export const CHECK_STATUSES = ["up", "down", "error"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/**
 * Fixed, non-sensitive messages. Do not interpolate raw URLs, response bodies,
 * headers, or underlying error text into these strings.
 */
export const SAFE_MESSAGES = {
  dns_failure: "DNS resolution failed.",
  connection_refused: "The destination refused the connection.",
  connection_failure: "The connection to the destination failed.",
  timeout: "The check timed out.",
  tls_error: "TLS negotiation or certificate verification failed.",
  http_status_mismatch: "The response status did not match the expected status.",
  body_mismatch: "The response body did not match the expected content.",
  redirect_loop: "The redirect chain looped or exceeded the allowed number of hops.",
  redirect_failure: "The redirect could not be followed safely.",
  blocked_target: "The destination is not allowed.",
  response_too_large: "The response exceeded the checker's size limit.",
  unsupported_configuration:
    "The monitor configuration is not supported by this checker version.",
  internal_error: "The checker encountered an internal error.",
  latency_threshold: "The response exceeded the latency threshold.",
  cancelled: "The check was cancelled.",
} as const satisfies Record<CheckErrorClass | "cancelled", string>;

export type SafeMessageKey = keyof typeof SAFE_MESSAGES;

export class CheckerError extends Error {
  readonly errorClass: CheckErrorClass;
  readonly safeMessage: string;

  constructor(errorClass: CheckErrorClass, safeMessage: string) {
    super(safeMessage);
    this.name = "CheckerError";
    this.errorClass = errorClass;
    this.safeMessage = safeMessage;
  }
}

export class UnsafeTargetError extends CheckerError {
  constructor(safeMessage: string = SAFE_MESSAGES.blocked_target) {
    super("blocked_target", safeMessage);
    this.name = "UnsafeTargetError";
  }
}

export class UnsupportedConfigurationError extends CheckerError {
  constructor(safeMessage: string = SAFE_MESSAGES.unsupported_configuration) {
    super("unsupported_configuration", safeMessage);
    this.name = "UnsupportedConfigurationError";
  }
}

export class DnsResolutionError extends CheckerError {
  readonly timedOut: boolean;

  constructor(timedOut = false) {
    super("dns_failure", SAFE_MESSAGES.dns_failure);
    this.name = "DnsResolutionError";
    this.timedOut = timedOut;
  }
}

export class RedirectError extends CheckerError {
  constructor(errorClass: "redirect_loop" | "redirect_failure") {
    super(errorClass, SAFE_MESSAGES[errorClass]);
    this.name = "RedirectError";
  }
}

export type TransportErrorKind =
  | "connection_refused"
  | "connection_failure"
  | "timeout"
  | "tls_error"
  | "response_too_large"
  | "aborted"
  | "internal_error";

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly safeMessage: string;

  constructor(kind: TransportErrorKind, safeMessage?: string) {
    const message =
      safeMessage ??
      (kind === "aborted"
        ? "The check was aborted."
        : SAFE_MESSAGES[kind]);
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.safeMessage = message;
  }
}

/** Used as an AbortSignal reason so transports can distinguish a timeout. */
export class CheckTimeoutError extends Error {
  constructor() {
    super(SAFE_MESSAGES.timeout);
    this.name = "CheckTimeoutError";
  }
}

/**
 * Used when the caller cancels a check. Cancellation is not a check result and
 * must not be persisted as an outage.
 */
export class CheckCancelledError extends Error {
  constructor() {
    super(SAFE_MESSAGES.cancelled);
    this.name = "CheckCancelledError";
  }
}
