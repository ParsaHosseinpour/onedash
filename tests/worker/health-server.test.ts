import { describe, expect, it } from "vitest";
import type { WorkerChecker } from "../../worker/checker/adapter";
import type { WorkerConfig } from "../../worker/config";
import type { IngestResult } from "../../worker/ingestor/ingestor-client";
import { createSilentLogger } from "../../worker/logging";
import type {
  ClaimResult,
  ExecutionStatus,
  FailResult,
  QueueMetrics,
  ReapResult,
  ReleaseResult,
} from "../../worker/queue/queue-client";
import { createHealthServer } from "../../worker/service/health-server";
import {
  WorkerRuntime,
  type WorkerIngestor,
  type WorkerQueue,
} from "../../worker/service/worker-runtime";

function config(): WorkerConfig {
  return {
    executionMode: "disabled",
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
    fixtureHosts: [],
    healthHost: "127.0.0.1",
    healthPort: 9464,
    metricsToken: "test-token-123456",
    logLevel: "debug",
  };
}

const metrics: QueueMetrics = {
  generatedAt: "2026-01-02T03:04:05.000Z",
  queueDepth: 7,
  leasedJobs: 1,
  completedJobs: 10,
  failedJobs: 2,
  retriedJobs: 3,
  expiredLeases: 1,
  oldestJobAgeSeconds: 42,
  schedulerDelaySeconds: 3,
  schedulerHeartbeatAgeSeconds: 1,
  workerHeartbeatAgeSeconds: 2,
  workerConcurrency: 2,
  timeoutResultsLastHour: 1,
  checkDurationMsAvgLastHour: 120,
};

class FakeQueue implements WorkerQueue {
  async claimJobs(): Promise<ClaimResult> {
    return { jobs: [], executionMode: "disabled", reason: null, claimedAt: null };
  }
  async extendLease(): Promise<boolean> {
    return true;
  }
  async releaseJob(): Promise<ReleaseResult> {
    return { ok: true, status: "pending", reason: null };
  }
  async failJob(): Promise<FailResult> {
    return { ok: true, status: "pending", retryAt: null, reason: null };
  }
  async reapExpiredLeases(): Promise<ReapResult> {
    return { recovered: 0, deadLettered: 0, reapedAt: null };
  }
  async recordHeartbeat(): Promise<void> {
    return undefined;
  }
  async getExecutionStatus(): Promise<ExecutionStatus> {
    return {
      enabled: false,
      mode: "disabled",
      reason: "test",
      egressVerifiedAt: null,
      egressVerifiedBy: null,
    };
  }
  async getMetrics(): Promise<QueueMetrics> {
    return metrics;
  }
  async ping(): Promise<void> {
    return undefined;
  }
}

class FakeIngestor implements WorkerIngestor {
  async ingest(): Promise<IngestResult> {
    return {
      ok: true,
      duplicate: false,
      jobStatus: "completed",
      resultId: "result-1",
      monitorStatus: "up",
      reason: null,
      retryable: null,
    };
  }
  async ping(): Promise<void> {
    return undefined;
  }
}

const checker: WorkerChecker = {
  async check() {
    throw new Error("not used");
  },
};

describe("health server", () => {
  it("serves health, readiness, and protected metrics", async () => {
    const queue = new FakeQueue();
    const ingestor = new FakeIngestor();
    const runtime = new WorkerRuntime({
      config: config(),
      queue,
      ingestor,
      checker,
      logger: createSilentLogger(),
    });
    const server = createHealthServer({
      host: "127.0.0.1",
      port: 0,
      metricsToken: "test-token-123456",
      runtime,
      queue,
      ingestor,
    });
    const address = await server.start();
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const readyUnauthorized = await fetch(`${base}/readyz`);
      expect(readyUnauthorized.status).toBe(401);

      const ready = await fetch(`${base}/readyz`, {
        headers: { authorization: "Bearer test-token-123456" },
      });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        status: "ready",
        dbReady: true,
        executionMode: "disabled",
      });

      const metricsUnauthorized = await fetch(`${base}/metrics`);
      expect(metricsUnauthorized.status).toBe(401);

      const metricsResponse = await fetch(`${base}/metrics`, {
        headers: { authorization: "Bearer test-token-123456" },
      });
      expect(metricsResponse.status).toBe(200);
      const body = await metricsResponse.json();
      expect(body).toMatchObject({
        executionMode: "disabled",
        concurrency: 2,
        queueMetricsError: false,
        queue: { queueDepth: 7, workerConcurrency: 2 },
      });

      const missing = await fetch(`${base}/missing`);
      expect(missing.status).toBe(404);

      const wrongMethod = await fetch(`${base}/healthz`, { method: "POST" });
      expect(wrongMethod.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("rejects an incorrect bearer token", async () => {
    const queue = new FakeQueue();
    const ingestor = new FakeIngestor();
    const runtime = new WorkerRuntime({
      config: config(),
      queue,
      ingestor,
      checker,
      logger: createSilentLogger(),
    });
    const server = createHealthServer({
      host: "127.0.0.1",
      port: 0,
      metricsToken: "test-token-123456",
      runtime,
      queue,
      ingestor,
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/metrics`, {
        headers: { authorization: "Bearer wrong-token-123456" },
      });
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
