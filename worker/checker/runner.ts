import { CheckCancelledError } from "./errors";
import { resolveCheckerLimits, type CheckerLimits } from "./limits";

export type RunWithConcurrencyOptions = {
  concurrency?: number;
  signal?: AbortSignal;
  /** Test seam only; the server ceiling is still enforced. */
  limits?: Partial<CheckerLimits>;
};

/**
 * Bounded worker pool. The concurrency value is clamped to the server maximum.
 * If one worker fails, no new items are scheduled, in-flight workers are
 * signalled to stop, and the first failure is rethrown after all workers have
 * settled so resources are not left behind.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  options: RunWithConcurrencyOptions = {},
): Promise<R[]> {
  const limits = resolveCheckerLimits(options.limits);
  const requested = options.concurrency ?? limits.maxConcurrency;

  if (!Number.isInteger(requested) || requested < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const concurrency = Math.min(requested, limits.maxConcurrency);

  if (options.signal?.aborted) {
    throw new CheckCancelledError();
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(new CheckCancelledError());

  if (options.signal) {
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        if (controller.signal.aborted) return;

        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;

        try {
          results[index] = await worker(
            items[index],
            index,
            controller.signal,
          );
        } catch (error) {
          if (firstError === undefined) {
            firstError = error;
          }
          controller.abort(
            error instanceof Error ? error : new CheckCancelledError(),
          );
          return;
        }
      }
    },
  );

  try {
    await Promise.allSettled(runners);

    if (firstError !== undefined) {
      throw firstError;
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new CheckCancelledError();
    }

    return results;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
