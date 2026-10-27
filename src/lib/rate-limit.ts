/**
 * Best-effort, in-process fixed-window rate limiting.
 *
 * LIMITATION: this state is per server instance and disappears on restart.
 * It is not a substitute for a shared limiter (Redis/Upstash), a WAF, or a
 * database-backed quota in a multi-instance/serverless deployment. It still
 * stops simple single-instance abuse and gives the API a clear 429 path.
 */

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

function pruneExpired(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): RateLimitDecision {
  if (limit <= 0 || windowMs <= 0) {
    return { allowed: false, retryAfterMs: windowMs, remaining: 0 };
  }

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      pruneExpired(now);

      // Never let unique attacker-controlled keys grow memory without bound.
      // Failing closed for brand-new keys is safer than unbounded storage.
      if (buckets.size >= MAX_BUCKETS) {
        return { allowed: false, retryAfterMs: windowMs, remaining: 0 };
      }
    }

    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0, remaining: limit - 1 };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, existing.resetAt - now),
      remaining: 0,
    };
  }

  existing.count += 1;

  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, limit - existing.count),
  };
}

/** Test-only helper so fixed-window state does not leak between tests. */
export function resetRateLimitsForTests() {
  buckets.clear();
}
