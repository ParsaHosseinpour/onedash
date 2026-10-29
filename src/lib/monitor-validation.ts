import { isIP } from "node:net";
import {
  DEFAULT_MONITOR_INTERVAL_SECONDS,
  MONITOR_MAX_INTERVAL_SECONDS,
  MONITOR_MAX_TIMEOUT_SECONDS,
  MONITOR_METHODS,
  MONITOR_MIN_INTERVAL_SECONDS,
  MONITOR_NAME_MAX_LENGTH,
  MONITOR_URL_MAX_LENGTH,
  emptyMonitorFormValues,
  parseExpectedStatusCodes,
  type MonitorConfigInput,
  type MonitorFieldErrors,
  type MonitorFormValues,
  type MonitorMethod,
} from "@/lib/monitor-config";

export type RawMonitorInput = {
  name: unknown;
  url: unknown;
  method: unknown;
  expectedStatus: unknown;
  intervalMinutes: unknown;
  timeoutSeconds: unknown;
  initialState: unknown;
};

export type MonitorValidationResult =
  | {
      ok: true;
      input: MonitorConfigInput;
      values: MonitorFormValues;
    }
  | {
      ok: false;
      fieldErrors: MonitorFieldErrors;
      values: MonitorFormValues;
    };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function isValidMethod(value: string): value is MonitorMethod {
  return (MONITOR_METHODS as readonly string[]).includes(value);
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(address: string): number[] | null {
  let value = address.toLowerCase().split("%")[0];

  // Convert a trailing dotted IPv4 part into two hexadecimal groups.
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) return null;

    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (!ipv4) return null;

    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;

  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  } else {
    groups = value.split(":");
  }

  if (groups.length !== 8) return null;

  const parsed = groups.map((group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return Number.NaN;
    return Number.parseInt(group, 16);
  });

  if (parsed.some((group) => !Number.isInteger(group))) return null;
  return parsed;
}

function embeddedIpv4IsBlocked(high: number, low: number): boolean {
  return isBlockedIpv4([
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ]);
}

function isBlockedIpv6(groups: number[]): boolean {
  if (groups.every((group) => group === 0)) return true; // ::

  // ::1 loopback
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }

  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;

  // ::ffff:0:0/96 IPv4-mapped
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff &&
    embeddedIpv4IsBlocked(groups[6], groups[7])
  ) {
    return true;
  }

  // ::/96 IPv4-compatible (deprecated)
  if (
    groups.slice(0, 6).every((group) => group === 0) &&
    embeddedIpv4IsBlocked(groups[6], groups[7])
  ) {
    return true;
  }

  // 64:ff9b::/96 NAT64
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0) &&
    embeddedIpv4IsBlocked(groups[6], groups[7])
  ) {
    return true;
  }

  // 2002::/16 6to4, which embeds an IPv4 address in groups 1 and 2.
  if (groups[0] === 0x2002 && embeddedIpv4IsBlocked(groups[1], groups[2])) {
    return true;
  }

  // 2001:db8::/32 documentation range.
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  return false;
}

/**
 * Rejects obvious non-public targets at configuration time. This is NOT the
 * Phase 4 SSRF boundary: it does not resolve DNS and makes no network request.
 * The checker must still revalidate every resolved address and redirect hop.
 */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const withoutBrackets = normalized.replace(/^\[/, "").replace(/\]$/, "");

  if (
    withoutBrackets === "localhost" ||
    withoutBrackets.endsWith(".localhost") ||
    withoutBrackets.endsWith(".local") ||
    withoutBrackets.endsWith(".internal") ||
    withoutBrackets.endsWith(".home.arpa")
  ) {
    return true;
  }

  const version = isIP(withoutBrackets);
  if (version === 4) {
    const octets = parseIpv4(withoutBrackets);
    return octets ? isBlockedIpv4(octets) : true;
  }

  if (version === 6) {
    const groups = parseIpv6(withoutBrackets);
    return groups ? isBlockedIpv6(groups) : true;
  }

  return false;
}

function validateUrl(value: string): string | null {
  if (!value) return "Enter a target URL.";
  if (value.length > MONITOR_URL_MAX_LENGTH) {
    return `Use ${MONITOR_URL_MAX_LENGTH} characters or fewer.`;
  }
  if (value.length < 8) return "Enter a valid absolute URL.";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Enter a valid absolute URL, including http:// or https://.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http:// and https:// URLs are supported.";
  }

  if (parsed.username || parsed.password) {
    return "Remove the username and password from the URL.";
  }

  if (!parsed.hostname) {
    return "Enter a URL with a hostname.";
  }

  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    return "Only ports 80 and 443 are supported in this release.";
  }

  if (isBlockedHostname(parsed.hostname)) {
    return "This host is not allowed. Use a public HTTP/HTTPS endpoint.";
  }

  if (parsed.toString().length > MONITOR_URL_MAX_LENGTH) {
    return `Use ${MONITOR_URL_MAX_LENGTH} characters or fewer.`;
  }

  return null;
}

export function validateMonitorForm(raw: RawMonitorInput): MonitorValidationResult {
  const name = asString(raw.name).trim();
  const url = asString(raw.url).trim();
  const method = asString(raw.method).trim().toUpperCase();
  const expectedStatus = asString(raw.expectedStatus).trim();
  const intervalMinutes = asString(raw.intervalMinutes).trim();
  const timeoutSeconds = asString(raw.timeoutSeconds).trim();
  const rawInitialState = asString(raw.initialState).trim();
  const initialState =
    rawInitialState === "" ? "active" : rawInitialState === "paused" ? "paused" : "active";

  const values: MonitorFormValues = {
    ...emptyMonitorFormValues,
    name,
    url,
    method,
    expectedStatus,
    intervalMinutes,
    timeoutSeconds,
    initialState,
  };

  const fieldErrors: MonitorFieldErrors = {};

  if (!name) {
    fieldErrors.name = "Enter a monitor name.";
  } else if (name.length > MONITOR_NAME_MAX_LENGTH) {
    fieldErrors.name = `Use ${MONITOR_NAME_MAX_LENGTH} characters or fewer.`;
  } else if (CONTROL_CHARACTERS.test(name)) {
    fieldErrors.name = "Remove control characters from the name.";
  }

  const urlError = validateUrl(url);
  if (urlError) {
    fieldErrors.url = urlError;
  }

  if (!isValidMethod(method)) {
    fieldErrors.method = "Choose a supported method: GET or HEAD.";
  }

  const statusResult = parseExpectedStatusCodes(expectedStatus);
  if (!statusResult.ok) {
    fieldErrors.expectedStatus = statusResult.message;
  }

  let intervalSeconds = DEFAULT_MONITOR_INTERVAL_SECONDS;
  if (!/^\d+(?:\.\d+)?$/.test(intervalMinutes)) {
    fieldErrors.intervalMinutes = "Enter the interval in minutes, for example 5.";
  } else {
    const minutes = Number(intervalMinutes);
    intervalSeconds = Math.round(minutes * 60);

    if (
      !Number.isFinite(intervalSeconds) ||
      intervalSeconds < MONITOR_MIN_INTERVAL_SECONDS ||
      intervalSeconds > MONITOR_MAX_INTERVAL_SECONDS
    ) {
      fieldErrors.intervalMinutes = `Use an interval between 1 and ${MONITOR_MAX_INTERVAL_SECONDS / 60} minutes.`;
    }
  }

  let timeout = Number.NaN;
  if (!/^\d+$/.test(timeoutSeconds)) {
    fieldErrors.timeoutSeconds = "Enter a whole number of seconds.";
  } else {
    timeout = Number(timeoutSeconds);
    if (timeout < 1 || timeout > MONITOR_MAX_TIMEOUT_SECONDS) {
      fieldErrors.timeoutSeconds = `Use a timeout between 1 and ${MONITOR_MAX_TIMEOUT_SECONDS} seconds.`;
    }
  }

  if (
    !fieldErrors.intervalMinutes &&
    !fieldErrors.timeoutSeconds &&
    timeout >= intervalSeconds
  ) {
    fieldErrors.timeoutSeconds = "Timeout must be shorter than the check interval.";
  }

  if (rawInitialState && rawInitialState !== "active" && rawInitialState !== "paused") {
    fieldErrors.initialState = "Choose active or paused.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, values };
  }

  return {
    ok: true,
    values,
    input: {
      name,
      url: new URL(url).toString(),
      method: method as MonitorMethod,
      expectedStatusCodes: statusResult.ok ? statusResult.codes : [200],
      intervalSeconds,
      timeoutSeconds: timeout,
      isActive: initialState === "active",
    },
  };
}

export function parseMonitorFormData(formData: FormData): MonitorValidationResult {
  return validateMonitorForm({
    name: formData.get("name"),
    url: formData.get("url"),
    method: formData.get("method"),
    expectedStatus: formData.get("expectedStatus"),
    intervalMinutes: formData.get("intervalMinutes"),
    timeoutSeconds: formData.get("timeoutSeconds"),
    initialState: formData.get("initialState"),
  });
}


