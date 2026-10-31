import { describe, expect, it } from "vitest";
import { CheckCancelledError } from "../../worker/checker/errors";
import { runWithConcurrency } from "../../worker/checker/runner";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runWithConcurrency", () => {
  it("clamps concurrency to the server maximum", async () => {
    let active = 0;
    let maximumActive = 0;

    const results = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      async (item) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await delay(10);
        active -= 1;
        return item * 2;
      },
      { concurrency: 100, limits: { maxConcurrency: 2 } },
    );

    expect(maximumActive).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("returns results in input order even when work finishes out of order", async () => {
    const results = await runWithConcurrency(
      [30, 5, 15],
      async (item) => {
        await delay(item);
        return `item-${item}`;
      },
      { concurrency: 3 },
    );

    expect(results).toEqual(["item-30", "item-5", "item-15"]);
  });

  it("returns an empty array for no items", async () => {
    await expect(
      runWithConcurrency([], async () => "never"),
    ).resolves.toEqual([]);
  });

  it("rejects invalid concurrency", async () => {
    await expect(
      runWithConcurrency([1], async () => 1, { concurrency: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      runWithConcurrency([1], async () => 1, { concurrency: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("stops scheduling new work after the first failure", async () => {
    const started: number[] = [];
    const failure = new Error("worker failed");

    await expect(
      runWithConcurrency(
        [0, 1, 2],
        async (item) => {
          started.push(item);
          if (item === 1) throw failure;
          return item;
        },
        { concurrency: 1 },
      ),
    ).rejects.toBe(failure);

    expect(started).toEqual([0, 1]);
  });

  it("waits for in-flight workers to settle before rejecting", async () => {
    let firstWorkerFinished = false;
    const failure = new Error("worker failed");

    await expect(
      runWithConcurrency(
        [0, 1],
        async (item) => {
          if (item === 0) {
            await delay(30);
            firstWorkerFinished = true;
            return item;
          }
          throw failure;
        },
        { concurrency: 2 },
      ),
    ).rejects.toBe(failure);

    expect(firstWorkerFinished).toBe(true);
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const pending = runWithConcurrency(
      [0, 1, 2],
      async (_item, _index, signal) => {
        started();
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
        return 0;
      },
      { concurrency: 2, signal: controller.signal },
    );

    await workerStarted;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(CheckCancelledError);
  });

  it("does not start work when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await expect(
      runWithConcurrency(
        [1],
        async () => {
          calls += 1;
          return 1;
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(CheckCancelledError);

    expect(calls).toBe(0);
  });
});
