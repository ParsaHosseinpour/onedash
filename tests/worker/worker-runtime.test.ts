import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CheckCancelledError,
  CheckerError,
  SAFE_MESSAGES,
  type CheckResult,
} from "../../worker/checker";
import type { WorkerChecker } from "../../worker/checker/adapter";
import type { WorkerConfig } from "../../worker/config";
import type {
  IngestResult,
} from "../../worker/ingestor/ingestor-client";
import type { IngestCheckResult } from "../../worker/ingestor/result-payload";
import { createSilentLogger } from "../../worker/logging";
import type {
  ClaimJobsInput,
  ClaimResult,
  ClaimedJob,
  ExecutionStatus,
  FailResult,
  HeartbeatDetails,
  JobErrorClass,
  QueueMetrics,
  ReapResult,
  ReleaseResult,
} from "../../worker/queue/queue-client";
import {
  WorkerRuntime,
  type WorkerIngestor,
  type WorkerQueue,
} from "../../worker/service/worker-runtime";

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    executionMode: "fixtures",
    queueDatabaseUrl: "postgresql://queue@example.test/db",
    ingestorDatabaseUrl: "postgresql://ingestor@example.test/db",
    dbSsl: false,
    region: "test-1",
    workerId: "worker-test",
    concurrency: 2,
    leaseSeconds: 30,
    pollIntervalMs: 1000,
    heartbeatIntervalMs: 5000,
    reapIntervalMs: 5000,
    shutdownGraceMs: 1000,
    fixtureHosts: ["fixture.test"],
    healthHost: "127.0.0.1",
    healthPort: 9464,
    metricsToken: null,
    logLevel: "debug",
    ...overrides,
  };
}

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    jobId: "job-1",
    leaseToken: "lease-1",
    monitorId: "monitor-1",
    region: "test-1",
    scheduledFor: "2026-01-02T03:04:05.000Z",
    attempts: 1,
    maxAttempts: 5,
    url: "https://fixture.test/health",
    method: "GET",
    expectedStatusCodes: [200],
    timeoutSeconds: 5,
    verifyTls: true,
    followRedirects: false,
    maxRedirects: 0,
    hasRequestSecrets: false,
    ...overrides,
  };
}

function checkResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    status: "up",
    httpStatus: 200,
    responseTimeMs: 10,
    dnsMs: 1,
    connectMs: 1,
    tlsMs: 1,
    ttfbMs: 1,
    totalMs: 10,
    errorClass: null,
    errorMessage: null,
    redirects: 0,
    responseBytes: 100,
    checkedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

const metrics: QueueMetrics = {
  generatedAt: null,
  queueDepth: 0,
  leasedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  retriedJobs: 0,
  expiredLeases: 0,
  oldestJobAgeSeconds: 0,
  schedulerDelaySeconds: 0,
  schedulerHeartbeatAgeSeconds: null,
  workerHeartbeatAgeSeconds: null,
  workerConcurrency: 0,
  timeoutResultsLastHour: 0,
  checkDurationMsAvgLastHour: 0,
};

class FakeQueue implements WorkerQueue {
  status: ExecutionStatus = {
    enabled: true,
    mode: "fixtures",
    reason: "test",
    egressVerifiedAt: null,
    egressVerifiedBy: null,
  };
  claimResult: ClaimResult = {
    jobs: [],
    executionMode: "fixtures",
    reason: null,
    claimedAt: null,
  };
  extendResult = true;
  releaseResult: ReleaseResult = { ok: true, status: "pending", reason: null };
  failResult: FailResult = {
    ok: true,
    status: "pending",
    retryAt: "2026-01-02T03:05:05.000Z",
    reason: null,
  };
  reapResult: ReapResult = { recovered: 0, deadLettered: 0, reapedAt: null };
  queueMetrics: QueueMetrics = metrics;

  claims: ClaimJobsInput[] = [];
  extensions: Array<{ jobId: string; leaseToken: string; leaseSeconds: number }> = [];
  releases: Array<{ jobId: string; leaseToken: string }> = [];
  failures: Array<{
    jobId: string;
    leaseToken: string;
    errorClass: JobErrorClass;
    retryable: boolean;
  }> = [];
  heartbeats: Array<{
    component: "scheduler" | "worker";
    instanceId: string;
    region: string;
    details: HeartbeatDetails;
  }> = [];
  statusCalls = 0;
  reapCalls = 0;

  async claimJobs(input: ClaimJobsInput): Promise<ClaimResult> {
    this.claims.push(input);
    return this.claimResult;
  }

  async extendLease(
    jobId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    this.extensions.push({ jobId, leaseToken, leaseSeconds });
    return this.extendResult;
  }

  async releaseJob(jobId: string, leaseToken: string): Promise<ReleaseResult> {
    this.releases.push({ jobId, leaseToken });
    return this.releaseResult;
  }

  async failJob(
    jobId: string,
    leaseToken: string,
    errorClass: JobErrorClass,
    retryable: boolean,
  ): Promise<FailResult> {
    this.failures.push({ jobId, leaseToken, errorClass, retryable });
    return this.failResult;
  }

  async reapExpiredLeases(): Promise<ReapResult> {
    this.reapCalls += 1;
    return this.reapResult;
  }

  async recordHeartbeat(
    component: "scheduler" | "worker",
    instanceId: string,
    region: string,
    details: HeartbeatDetails,
  ): Promise<void> {
    this.heartbeats.push({ component, instanceId, region, details });
  }

  async getExecutionStatus(): Promise<ExecutionStatus> {
    this.statusCalls += 1;
    return this.status;
  }

  async getMetrics(): Promise<QueueMetrics> {
    return this.queueMetrics;
  }

  async ping(): Promise<void> {
    return undefined;
  }
}

class FakeIngestor implements WorkerIngestor {
  result: IngestResult = {
    ok: true,
    duplicate: false,
    jobStatus: "completed",
    resultId: "result-1",
    monitorStatus: "up",
    reason: null,
  };
  ingests: Array<{
    jobId: string;
    leaseToken: string;
    result: IngestCheckResult;
  }> = [];

  async ingest(
    jobId: string,
    leaseToken: string,
    result: IngestCheckResult,
  ): Promise<IngestResult> {
    this.ingests.push({ jobId, leaseToken, result });
    return this.result;
  }

  async ping(): Promise<void> {
    return undefined;
  }
}

function setup(options: {
  config?: Partial<WorkerConfig>;
  queue?: FakeQueue;
  ingestor?: FakeIngestor;
  checker?: WorkerChecker;
} = {}) {
  const queue = options.queue ?? new FakeQueue();
  const ingestor = options.ingestor ?? new FakeIngestor();
  const checker = options.checker ?? {
    async check() {
      return checkResult();
    },
  };
  const runtime = new WorkerRuntime({
    config: config(options.config),
    queue,
    ingestor,
    checker,
    logger: createSilentLogger(),
  });
  return { runtime, queue, ingestor, checker };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkerRuntime runOnce", () => {
  it("does nothing in disabled mode", async () => {
    const { runtime, queue } = setup({ config: { executionMode: "disabled" } });
    await runtime.runOnce();
    expect(queue.statusCalls).toBe(0);
    expect(queue.claims).toHaveLength(0);
  });

  it("does not claim while the database execution gate is disabled", async () => {
    const queue = new FakeQueue();
    queue.status = { ...queue.status, enabled: false, mode: "disabled" };
    const { runtime } = setup({ queue });
    await runtime.runOnce();
    expect(queue.claims).toHaveLength(0);
  });

  it("does not claim in customer mode", async () => {
    const queue = new FakeQueue();
    queue.status = { ...queue.status, enabled: true, mode: "customer" };
    const { runtime } = setup({ queue });
    await runtime.runOnce();
    expect(queue.claims).toHaveLength(0);
  });

  it("claims only free concurrency slots and releases overflow", async () => {
    const queue = new FakeQueue();
    queue.claimResult = {
      jobs: [job({ jobId: "job-1" }), job({ jobId: "job-2" }), job({ jobId: "job-3" })],
      executionMode: "fixtures",
      reason: null,
      claimedAt: null,
    };

    const resolvers = new Map<string, (value: CheckResult) => void>();
    const checker: WorkerChecker = {
      check: (claimed) =>
        new Promise<CheckResult>((resolve) => {
          resolvers.set(claimed.jobId, resolve);
        }),
    };

    const { runtime } = setup({ queue, checker, config: { concurrency: 2 } });
    await runtime.runOnce();

    expect(queue.claims[0].batchSize).toBe(2);
    expect(queue.releases).toHaveLength(1);
    expect(queue.releases[0].jobId).toBe("job-3");
    expect(runtime.getMetrics().inFlight).toBe(2);

    resolvers.get("job-1")?.(checkResult());
    resolvers.get("job-2")?.(checkResult());
    await runtime.waitForIdle();
    expect(runtime.getMetrics().completedTotal).toBe(2);
  });

  it("ingests a genuine checker result and counts completion", async () => {
    const queue = new FakeQueue();
    queue.claimResult = {
      jobs: [job()],
      executionMode: "fixtures",
      reason: null,
      claimedAt: null,
    };
    const { runtime, ingestor } = setup({ queue });

    await runtime.runOnce();
    await runtime.waitForIdle();

    expect(ingestor.ingests).toHaveLength(1);
    expect(ingestor.ingests[0].jobId).toBe("job-1");
    expect(ingestor.ingests[0].leaseToken).toBe("lease-1");
    expect(ingestor.ingests[0].result.status).toBe("up");
    expect(ingestor.ingests[0].result).not.toHaveProperty("url");
    expect(runtime.getMetrics().completedTotal).toBe(1);
    expect(runtime.getMetrics().checkDurationCount).toBe(1);
    expect(runtime.getMetrics().checkDurationSumMs).toBe(10);
    expect(queue.failures).toHaveLength(0);
  });

  it("schedules an exponential-backoff retry for a checker timeout", async () => {
    const queue = new FakeQueue();
    queue.claimResult = {
      jobs: [job()],
      executionMode: "fixtures",
      reason: null,
      claimedAt: null,
    };
    const checker: WorkerChecker = {
      async check() {
        throw new CheckerError("timeout", SAFE_MESSAGES.timeout);
      },
    };
    const { runtime } = setup({ queue, checker });

    await runtime.runOnce();
    await runtime.waitForIdle();

    expect(queue.failures).toHaveLength(1);
    expect(queue.failures[0].errorClass).toBe("timeout");
    expect(queue.failures[0].retryable).toBe(true);
    expect(runtime.getMetrics().retriedTotal).toBe(1);
    expect(runtime.getMetrics().completedTotal).toBe(0);
  });

  it("counts a dead-letter terminal failure", async () => {
    const queue = new FakeQueue();
    queue.claimResult = {
      jobs: [job()],
      executionMode: "fixtures",
      reason: null,
      claimedAt: null,
    };
    queue.failResult = {
      ok: true,
      status: "dead_letter",
      retryAt: null,
      reason: null,
    };
    const checker: WorkerChecker = {
      async check() {
        throw new Error("unexpected worker failure");
      },
    };
    const { runtime } = setup({ queue, checker });

    await runtime.runOnce();
    await runtime.waitForIdle();

    expect(queue.failures[0].errorClass).toBe("worker_error");
    expect(runtime.getMetrics().failedTotal).toBe(1);
    expect(runtime.getMetrics().retriedTotal).toBe(0);
  });

  it("releases an in-flight job during graceful shutdown", async () => {
    const queue = new FakeQueue();
    queue.claimResult = {
      jobs: [job()],
      executionMode: "fixtures",
      reason: null,
      claimedAt: null,
    };
    const checker: WorkerChecker = {
      check: (_claimed, signal) =>
        new Promise<CheckResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new CheckCancelledError()),
            { once: true },
          );
        }),
    };
    const { runtime } = setup({ queue, checker, config: { shutdownGraceMs: 1000 } });

    await runtime.runOnce();
    expect(runtime.getMetrics().inFlight).toBe(1);
    await runtime.stop("test");

    expect(queue.releases).toHaveLength(1);
    expect(queue.releases[0].jobId).toBe("job-1");
    expect(runtime.getMetrics().releasedTotal).toBe(1);
  });

  it("abandons a job when the lease is lost", async () => {
    vi.useFakeTimers();
    const queue = new FakeQueue();
    queue.claimResult = {
      jobs: [job({ timeoutSeconds: 60 })],
      executionMode: "fixtures",
      reason: null,
      claimedAt: null,
    };
    queue.extendResult = false;
    const checker: WorkerChecker = {
      check: (_claimed, signal) =>
        new Promise<CheckResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new CheckCancelledError()),
            { once: true },
          );
        }),
    };
    const { runtime } = setup({ queue, checker, config: { leaseSeconds: 30 } });

    await runtime.runOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    await runtime.waitForIdle();

    expect(queue.extensions).toHaveLength(1);
    expect(queue.failures).toHaveLength(0);
    expect(queue.releases).toHaveLength(0);
  });

  it("fails a job that exceeds the worker safety timeout", async () => {
    vi.useFakeTimers();
    const queue = new FakeQueue();
    queue.claimResult = {
      jobs: [job({ timeoutSeconds: 1 })],
      executionMode: "fixtures",
      reason: null,
      claimedAt: null,
    };
    const checker: WorkerChecker = {
      check: (_claimed, signal) =>
        new Promise<CheckResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new CheckCancelledError()),
            { once: true },
          );
        }),
    };
    const { runtime } = setup({ queue, checker });

    await runtime.runOnce();
    await vi.advanceTimersByTimeAsync(6000);
    await runtime.waitForIdle();

    expect(queue.failures).toHaveLength(1);
    expect(queue.failures[0].errorClass).toBe("timeout");
    expect(runtime.getMetrics().timeoutTotal).toBe(1);
  });
});
