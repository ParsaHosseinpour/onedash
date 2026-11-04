import { describe, expect, it } from "vitest";
import type { SchedulerConfig } from "../../worker/config";
import { createSilentLogger } from "../../worker/logging";
import type {
  ExecutionStatus,
  HeartbeatDetails,
  QueueMetrics,
  ReapResult,
} from "../../worker/queue/queue-client";
import type { ScheduleSummary } from "../../worker/scheduler/scheduler-client";
import {
  SchedulerRuntime,
  type SchedulerClientLike,
} from "../../worker/scheduler/scheduler-runtime";

function config(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    schedulerDatabaseUrl: "postgresql://scheduler@example.test/db",
    dbSsl: false,
    schedulerId: "scheduler-test",
    region: "global",
    intervalMs: 5000,
    batchSize: 50,
    jitterSeconds: 10,
    logLevel: "debug",
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

class FakeSchedulerClient implements SchedulerClientLike {
  status: ExecutionStatus = {
    enabled: true,
    mode: "fixtures",
    reason: "test",
    egressVerifiedAt: null,
    egressVerifiedBy: null,
  };
  scheduleResult: ScheduleSummary = {
    scheduled: 2,
    skipped: 1,
    executionMode: "fixtures",
    reason: null,
    evaluatedAt: "2026-01-02T03:04:05.000Z",
  };
  reapResult: ReapResult = {
    recovered: 1,
    deadLettered: 0,
    reapedAt: "2026-01-02T03:04:05.000Z",
  };

  statusCalls = 0;
  scheduleCalls = 0;
  reapCalls = 0;
  heartbeats: Array<{
    component: "scheduler" | "worker";
    instanceId: string;
    region: string;
    details: HeartbeatDetails;
  }> = [];
  lastBatchSize: number | null = null;
  lastJitterSeconds: number | null = null;

  async scheduleDueJobs(
    batchSize: number,
    jitterSeconds: number,
  ): Promise<ScheduleSummary> {
    this.scheduleCalls += 1;
    this.lastBatchSize = batchSize;
    this.lastJitterSeconds = jitterSeconds;
    return this.scheduleResult;
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
    return metrics;
  }

  async ping(): Promise<void> {
    return undefined;
  }
}

describe("SchedulerRuntime", () => {
  it("reaps, schedules, and heartbeats in one tick", async () => {
    const client = new FakeSchedulerClient();
    const runtime = new SchedulerRuntime({
      config: config(),
      client,
      logger: createSilentLogger(),
      now: () => Date.parse("2026-01-02T03:04:05.000Z"),
    });

    await runtime.runOnce();

    expect(client.statusCalls).toBe(1);
    expect(client.reapCalls).toBe(1);
    expect(client.scheduleCalls).toBe(1);
    expect(client.lastBatchSize).toBe(50);
    expect(client.lastJitterSeconds).toBe(10);
    expect(client.heartbeats).toHaveLength(1);
    expect(client.heartbeats[0]).toMatchObject({
      component: "scheduler",
      instanceId: "scheduler-test",
      region: "global",
      details: {
        batch_size: 50,
        jitter_seconds: 10,
        last_scheduled: 2,
        last_skipped: 1,
        execution_mode: "fixtures",
      },
    });

    expect(runtime.getMetrics()).toMatchObject({
      ticks: 1,
      scheduledTotal: 2,
      skippedTotal: 1,
      reapedTotal: 1,
      deadLetteredTotal: 0,
      lastTickAt: "2026-01-02T03:04:05.000Z",
      lastHeartbeatAt: "2026-01-02T03:04:05.000Z",
      lastErrorClass: null,
    });
  });

  it("still heartbeats while the execution gate is disabled", async () => {
    const client = new FakeSchedulerClient();
    client.status = { ...client.status, enabled: false, mode: "disabled" };
    client.scheduleResult = {
      scheduled: 0,
      skipped: 0,
      executionMode: "disabled",
      reason: "execution disabled",
      evaluatedAt: "2026-01-02T03:04:05.000Z",
    };
    const runtime = new SchedulerRuntime({
      config: config(),
      client,
      logger: createSilentLogger(),
    });

    await runtime.runOnce();

    expect(client.scheduleCalls).toBe(1);
    expect(client.heartbeats[0].details.execution_mode).toBe("disabled");
    expect(runtime.getMetrics().scheduledTotal).toBe(0);
  });

  it("observes customer mode without scheduling customer work", async () => {
    const client = new FakeSchedulerClient();
    client.status = {
      ...client.status,
      enabled: true,
      mode: "customer",
      egressVerifiedAt: "2026-01-02T03:04:05.000Z",
      egressVerifiedBy: "operator",
    };
    client.scheduleResult = {
      scheduled: 0,
      skipped: 0,
      executionMode: "customer",
      reason: "customer execution is not implemented in Phase 4B",
      evaluatedAt: "2026-01-02T03:04:05.000Z",
    };
    const runtime = new SchedulerRuntime({
      config: config(),
      client,
      logger: createSilentLogger(),
    });

    await runtime.runOnce();

    expect(client.scheduleCalls).toBe(1);
    expect(client.heartbeats[0].details.execution_mode).toBe("customer");
    expect(runtime.getMetrics().scheduledTotal).toBe(0);
  });

  it("propagates a tick error to the loop", async () => {
    const client = new FakeSchedulerClient();
    client.getExecutionStatus = async () => {
      throw new Error("database unavailable");
    };
    const runtime = new SchedulerRuntime({
      config: config(),
      client,
      logger: createSilentLogger(),
    });

    await expect(runtime.runOnce()).rejects.toThrow("database unavailable");
  });

  it("does not run after stop", async () => {
    const client = new FakeSchedulerClient();
    const runtime = new SchedulerRuntime({
      config: config(),
      client,
      logger: createSilentLogger(),
    });

    await runtime.stop("test");
    await runtime.runOnce();

    expect(client.statusCalls).toBe(0);
    expect(client.scheduleCalls).toBe(0);
  });
});
