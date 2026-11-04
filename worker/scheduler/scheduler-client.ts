import type { Pool } from "pg";
import { createDbPool, pgErrorCode } from "../db";
import {
  asNullableString,
  asNumber,
  asRecord,
  asString,
} from "../protocol";
import {
  parseExecutionStatus,
  parseQueueMetrics,
  parseReapResult,
  type ExecutionStatus,
  type HeartbeatDetails,
  type QueueMetrics,
  type ReapResult,
} from "../queue/queue-client";

export type ScheduleSummary = {
  scheduled: number;
  skipped: number;
  executionMode: string;
  reason: string | null;
  evaluatedAt: string | null;
};

export type SchedulerClientOptions = {
  connectionString: string;
  ssl: boolean;
  max?: number;
  onPoolError?: (error: unknown) => void;
};

export class SchedulerClientError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super("scheduler operation failed");
    this.name = "SchedulerClientError";
    this.code = code;
  }
}

function parseScheduleSummary(value: unknown): ScheduleSummary {
  const record = asRecord(value);
  return {
    scheduled: asNumber(record.scheduled, "scheduled"),
    skipped: asNumber(record.skipped, "skipped"),
    executionMode: asString(record.execution_mode, "execution_mode"),
    reason: asNullableString(record.reason, "reason"),
    evaluatedAt: asNullableString(record.evaluated_at, "evaluated_at"),
  };
}

export class SchedulerClient {
  private readonly pool: Pool;

  constructor(options: SchedulerClientOptions) {
    this.pool = createDbPool({
      connectionString: options.connectionString,
      ssl: options.ssl,
      applicationName: "onedash-scheduler",
      max: options.max ?? 2,
      onError: options.onPoolError,
    });
  }

  private async queryResult(sql: string, params: unknown[]): Promise<unknown> {
    try {
      const result = await this.pool.query<{ result: unknown }>(sql, params);
      return result.rows[0]?.result;
    } catch (error) {
      throw new SchedulerClientError(pgErrorCode(error));
    }
  }

  async scheduleDueJobs(
    batchSize: number,
    jitterSeconds: number,
  ): Promise<ScheduleSummary> {
    const value = await this.queryResult(
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [batchSize, jitterSeconds],
    );
    return parseScheduleSummary(value);
  }

  async reapExpiredLeases(limit: number): Promise<ReapResult> {
    const value = await this.queryResult(
      "select public.onedash_reap_expired_leases($1) as result",
      [limit],
    );
    return parseReapResult(value);
  }

  async recordHeartbeat(
    component: "scheduler" | "worker",
    instanceId: string,
    region: string,
    details: HeartbeatDetails,
  ): Promise<void> {
    await this.queryResult(
      "select public.onedash_record_heartbeat($1, $2, $3, $4::jsonb) as result",
      [component, instanceId, region, JSON.stringify(details)],
    );
  }

  async getExecutionStatus(): Promise<ExecutionStatus> {
    const value = await this.queryResult(
      "select public.onedash_execution_status() as result",
      [],
    );
    return parseExecutionStatus(value);
  }

  async getMetrics(): Promise<QueueMetrics> {
    const value = await this.queryResult(
      "select public.onedash_queue_metrics() as result",
      [],
    );
    return parseQueueMetrics(value);
  }

  async ping(): Promise<void> {
    try {
      await this.pool.query("select 1");
    } catch (error) {
      throw new SchedulerClientError(pgErrorCode(error));
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
