import ipaddr from "ipaddr.js";

/**
 * A resolved or literal IP address. The address is normalized with the
 * maintained `ipaddr.js` parser before it is validated or pinned.
 */
export type ParsedAddress = {
  address: string;
  family: 4 | 6;
};

function isIpv6(value: ipaddr.IPv4 | ipaddr.IPv6): value is ipaddr.IPv6 {
  return value.kind() === "ipv6";
}

function parse(value: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.includes("%") || /\s/.test(value)) return null;
  // `ipaddr.js` normalizes dotted IPv4-compatible forms such as `::8.8.8.8`
  // to IPv4-mapped addresses. They are deprecated, not globally routable, and
  // are not the `::ffff:0:0/96` mapped form, so reject the original spelling.
  if (/^::(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value)) return null;
  if (!ipaddr.isValid(value)) return null;

  const parsed = ipaddr.parse(value);
  if (isIpv6(parsed) && parsed.zoneId) return null;
  return parsed;
}

/**
 * Parses and normalizes an IP address. Returns null for malformed input,
 * zone-scoped addresses, and anything the maintained parser cannot classify.
 */
export function parseIpAddress(value: string): ParsedAddress | null {
  const parsed = parse(value);
  if (!parsed) return null;

  if (!isIpv6(parsed)) {
    return { address: parsed.toString(), family: 4 };
  }

  return { address: parsed.toRFC5952String(), family: 6 };
}

/**
 * Allows only globally routable unicast addresses. IPv4-mapped IPv6 addresses
 * are unwrapped and checked against the embedded IPv4 address, so
 * `::ffff:127.0.0.1` is rejected even though `ipaddr.js` reports the outer
 * address as `ipv4Mapped` rather than `loopback`.
 */
export function isPublicIpAddress(value: string): boolean {
  const parsed = parse(value);
  if (!parsed) return false;

  if (isIpv6(parsed)) {
    // IPv4-compatible `::/96` addresses are deprecated and not globally
    // routable. Some stacks have historically treated them as IPv4, so reject
    // the entire block before applying the maintained range table.
    if (parsed.parts.slice(0, 6).every((part) => part === 0)) {
      return false;
    }

    if (parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address().range() === "unicast";
    }

    // `ipaddr.js` labels some reserved IPv6 blocks (for example 4000::/3 and
    // 8000::/3) as "unicast". Only 2000::/3 is global unicast, so enforce the
    // IANA global-unicast prefix before applying the maintained range table.
    if ((parsed.parts[0] & 0xe000) !== 0x2000) {
      return false;
    }
  }

  return parsed.range() === "unicast";
}

/** The production address policy. There is deliberately no way to replace it. */
export const publicAddressPolicy = isPublicIpAddress;
