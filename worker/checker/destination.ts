import { lookup } from "node:dns/promises";
import { performance } from "node:perf_hooks";
import {
  CheckCancelledError,
  CheckTimeoutError,
  DnsResolutionError,
  UnsafeTargetError,
} from "./errors";
import {
  parseIpAddress,
  publicAddressPolicy,
  type ParsedAddress,
} from "./ip-policy";
import type { ValidatedTarget } from "./url-policy";

export type ResolvedAddress = ParsedAddress;

export type DnsLookupOptions = {
  signal: AbortSignal;
  timeoutMs: number;
};

export interface DnsResolver {
  resolve(hostname: string, options: DnsLookupOptions): Promise<ResolvedAddress[]>;
}

export type Destination = {
  /** Every address returned by DNS, normalized, deduplicated, and validated. */
  addresses: ResolvedAddress[];
  /** The first validated address; retained for callers that only want one. */
  pinned: ResolvedAddress;
  dnsMs: number;
};

export type ResolveDestinationOptions = {
  resolver: DnsResolver;
  signal: AbortSignal;
  dnsTimeoutMs: number;
  /**
   * Test seam only. Production callers must omit this so the immutable public
   * address policy is always used. It is rejected outside NODE_ENV=test.
   */
  addressPolicy?: (address: string) => boolean;
};

function selectAddressPolicy(
  options: ResolveDestinationOptions,
): (address: string) => boolean {
  if (!options.addressPolicy) return publicAddressPolicy;
  if (process.env.NODE_ENV !== "test") {
    throw new Error("custom destination address policies are test-only");
  }
  return options.addressPolicy;
}

class DnsTimeoutError extends Error {
  constructor() {
    super("dns timeout");
    this.name = "DnsTimeoutError";
  }
}

/**
 * System resolver wrapper. The underlying `dns.lookup` call cannot be
 * interrupted, so the wrapper races it against the caller's signal and a
 * bounded timer. A late lookup result is ignored.
 */
export function createSystemDnsResolver(): DnsResolver {
  return {
    async resolve(hostname, { signal, timeoutMs }) {
      if (signal.aborted) {
        throw signal.reason ?? new CheckCancelledError();
      }

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DnsTimeoutError()),
        Math.max(1, timeoutMs),
      );
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }

      try {
        const result = await Promise.race([
          lookup(hostname, { all: true, verbatim: true }),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(controller.signal.reason),
              { once: true },
            );
          }),
        ]);

        if (signal.aborted) {
          throw signal.reason ?? new CheckCancelledError();
        }

        return result.map((entry) => ({
          address: entry.address,
          family: entry.family === 6 ? 6 : 4,
        }));
      } catch (error) {
        if (
          error instanceof CheckCancelledError ||
          error instanceof CheckTimeoutError
        ) {
          throw error;
        }
        if (signal.aborted) {
          throw signal.reason ?? new CheckCancelledError();
        }
        if (error instanceof DnsTimeoutError) {
          throw new DnsResolutionError(true);
        }
        throw new DnsResolutionError(false);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Validates every DNS answer and returns the complete validated list. The
 * checker pins and tries up to its own strict address-attempt cap. Mixed
 * public/private answers are rejected as a whole; the checker never selects
 * the "public" subset and hopes for the best.
 */
export async function resolveDestination(
  target: ValidatedTarget,
  options: ResolveDestinationOptions,
): Promise<Destination> {
  const addressPolicy = selectAddressPolicy(options);

  if (target.isIpLiteral) {
    const literal = target.ipLiteral;
    if (!literal || !addressPolicy(literal.address)) {
      throw new UnsafeTargetError();
    }
    return { addresses: [literal], pinned: literal, dnsMs: 0 };
  }

  const started = performance.now();
  let answers: ResolvedAddress[];

  try {
    answers = await options.resolver.resolve(target.hostname, {
      signal: options.signal,
      timeoutMs: options.dnsTimeoutMs,
    });
  } catch (error) {
    if (
      error instanceof CheckCancelledError ||
      error instanceof CheckTimeoutError ||
      error instanceof DnsResolutionError
    ) {
      throw error;
    }
    if (options.signal.aborted) {
      throw options.signal.reason ?? new CheckCancelledError();
    }
    throw new DnsResolutionError(false);
  }

  const dnsMs = Math.max(0, Math.round(performance.now() - started));

  if (!Array.isArray(answers) || answers.length === 0) {
    throw new DnsResolutionError(false);
  }

  const validated: ResolvedAddress[] = [];
  const seen = new Set<string>();

  for (const answer of answers) {
    const parsed =
      typeof answer?.address === "string"
        ? parseIpAddress(answer.address)
        : null;
    if (!parsed) {
      // A malformed answer is a resolver failure, not proof that the target is
      // private. Keep the two result classes distinct.
      throw new DnsResolutionError(false);
    }
    if (!addressPolicy(parsed.address)) {
      throw new UnsafeTargetError();
    }
    if (!seen.has(parsed.address)) {
      seen.add(parsed.address);
      validated.push(parsed);
    }
  }

  if (validated.length === 0) {
    throw new DnsResolutionError(false);
  }

  return {
    addresses: validated,
    pinned: validated[0],
    dnsMs,
  };
}
