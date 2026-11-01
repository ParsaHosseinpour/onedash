import {
  RedirectError,
  UnsafeTargetError,
  UnsupportedConfigurationError,
} from "./errors";
import type { CheckerLimits } from "./limits";
import { parseIpAddress, type ParsedAddress } from "./ip-policy";

/**
 * A URL that passed syntax, scheme, credential, port, and hostname validation.
 * Address policy is applied later, after DNS resolution, so the checker can
 * validate every returned address and reject mixed public/private answers.
 */
export type ValidatedTarget = {
  url: URL;
  /** Hostname without IPv6 brackets or a trailing dot. */
  hostname: string;
  port: number;
  isIpLiteral: boolean;
  ipLiteral: ParsedAddress | null;
  /** URL with the fragment removed, used for redirect-loop detection. */
  canonical: string;
};

const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const NUMERIC_HOST = /^[0-9.]+$/;
const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([80, 443]);

const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "home.arpa",
  "lan",
  "corp",
  "home",
  "intranet",
  "private",
] as const;

function unsupported(): never {
  throw new UnsupportedConfigurationError();
}

function blocked(): never {
  throw new UnsafeTargetError();
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function validateHostname(hostname: string): void {
  if (hostname.length === 0 || hostname.length > 253) unsupported();
  if (hostname.includes("%")) unsupported();

  const lower = hostname.toLowerCase();
  if (lower === "localhost") blocked();
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (lower === suffix || lower.endsWith(`.${suffix}`)) blocked();
  }

  // A single-label name can only resolve through a local search domain. The
  // product targets public HTTP/HTTPS endpoints, so require a dotted name.
  if (!lower.includes(".")) unsupported();

  const labels = lower.split(".");
  if (labels.some((label) => !LABEL.test(label))) unsupported();

  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld)) unsupported();
  if (NUMERIC_HOST.test(lower)) unsupported();
}

function normalizeHostname(hostname: string): string {
  return stripIpv6Brackets(hostname).replace(/\.$/, "");
}

function selectAllowedPorts(
  allowedPorts: readonly number[],
): readonly number[] {
  if (process.env.NODE_ENV === "test") return allowedPorts;
  if (allowedPorts !== DEFAULT_ALLOWED_PORTS) {
    throw new Error("custom checker ports are test-only");
  }
  return DEFAULT_ALLOWED_PORTS;
}

function allowedPort(
  url: URL,
  allowedPorts: readonly number[],
): number {
  if (!url.port) {
    return url.protocol === "https:" ? 443 : 80;
  }

  const port = Number(url.port);
  if (!allowedPorts.includes(port)) unsupported();
  return port;
}

/**
 * Validates an absolute target URL. It deliberately does not perform DNS or
 * apply the address policy; that is the destination layer's job.
 */
export function validateTargetUrl(
  raw: string,
  limits: CheckerLimits,
  allowedPorts: readonly number[] = DEFAULT_ALLOWED_PORTS,
): ValidatedTarget {
  const ports = selectAllowedPorts(allowedPorts);
  if (typeof raw !== "string") unsupported();
  if (raw.length < 8 || raw.length > limits.maxUrlLength) unsupported();
  if (raw !== raw.trim()) unsupported();
  if (CONTROL_OR_SPACE.test(raw)) unsupported();
  // WHATWG URL treats backslashes as slashes for special schemes. Reject them
  // rather than relying on parser-specific normalization.
  if (raw.includes("\\")) unsupported();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    unsupported();
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") unsupported();
  if (url.username || url.password) unsupported();
  if (!url.hostname) unsupported();

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) unsupported();
  if (hostname.includes("%")) unsupported();

  const ipLiteral = parseIpAddress(hostname);
  if (!ipLiteral) {
    validateHostname(hostname);
  }

  const port = allowedPort(url, ports);

  // Remove a trailing dot and the fragment. The fragment is never sent and
  // must not create a distinct loop-detection key.
  url.hostname = hostname;
  url.hash = "";

  const canonical = url.toString();
  if (canonical.length > limits.maxUrlLength) unsupported();

  return {
    url,
    hostname,
    port,
    isIpLiteral: ipLiteral !== null,
    ipLiteral,
    canonical,
  };
}

/**
 * Resolves a `Location` header against the current URL and applies the same
 * absolute-URL validation. A redirect to a blocked host is surfaced as
 * `blocked_target`; malformed or unsupported redirects are `redirect_failure`.
 */
export function parseRedirectTarget(
  location: string | null,
  base: URL,
  limits: CheckerLimits,
  allowedPorts: readonly number[] = DEFAULT_ALLOWED_PORTS,
): ValidatedTarget {
  if (!location) {
    throw new RedirectError("redirect_failure");
  }

  const trimmed = location.trim();
  if (!trimmed || trimmed.length > limits.maxUrlLength * 2) {
    throw new RedirectError("redirect_failure");
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || trimmed.includes("\\")) {
    throw new RedirectError("redirect_failure");
  }

  let next: URL;
  try {
    next = new URL(trimmed, base);
  } catch {
    throw new RedirectError("redirect_failure");
  }

  let target: ValidatedTarget;
  try {
    target = validateTargetUrl(next.toString(), limits, allowedPorts);
  } catch (error) {
    if (error instanceof UnsafeTargetError) throw error;
    throw new RedirectError("redirect_failure");
  }

  // An HTTPS check must never be silently downgraded to plaintext HTTP. This
  // is checked on every hop, so a chain cannot bypass it by starting with an
  // HTTPS-to-HTTPS redirect. There is intentionally no monitor option to
  // disable this protection.
  if (base.protocol === "https:" && target.url.protocol === "http:") {
    throw new RedirectError("redirect_failure");
  }

  return target;
}
