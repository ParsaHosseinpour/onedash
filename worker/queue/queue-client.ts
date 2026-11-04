import type { Pool } from "pg";
import { createDbPool, pgErrorCode } from "../db";
import {
  ProtocolError,
  asBoolean,
  asEnum,
  asNullableNumber,
  asNullableString,
  asNumber,
  asNumberArray,
  asRecord,
  asString,
} from "../protocol";

export type JobErrorClass =
  | "internal_error"
  | "timeout"
  | "worker_error"
  | "worker_shutdown"
  | "blocked_target";

export type ClaimedJob = {
  jobId: string;
  leaseToken: string;
  monitorId: string;
  region: string;
  scheduledFor: string;
  attempts: number;
  maxAttempts: number;
  url: string;
  method: "GET" | "HEAD";
  expectedStatusCodes: number[];
  timeoutSeconds: number;
  verifyTls: boolean;
  followRedirects: boolean;
  maxRedirects: number;
  hasRequestSecrets: boolean;
};

export type ClaimResult = {
  jobs: ClaimedJob[];
  executionMode: string;
  reason: string | null;
  claimedAt: string | null;
};

export type ExecutionStatus = {
  enabled: boolean;
  mode: string;
  reason: string;
  egressVerifiedAt: string | null;
  egressVerifiedBy: string | null;
};

export type QueueMetrics = {
  generatedAt: string | null;
  queueDepth: number;
  leasedJobs: number;
  completedJobs: number;
  failedJobs: number;
  retriedJobs: number;
  expiredLeases: number;
  oldestJobAgeSeconds: number;
  schedulerDelaySeconds: number;
  schedulerHeartbeatAgeSeconds: number | null;
  workerHeartbeatAgeSeconds: number | null;
  workerConcurrency: number;
  timeoutResultsLastHour: number;
  checkDurationMsAvgLastHour: number;
};

export type ReapResult = {
  recovered: number;
  deadLettered: number;
  reapedAt: string | null;
};

export type ReleaseResult = {
  ok: boolean;
  status: string | null;
  reason: string | null;
};

export type FailResult = {
  ok: boolean;
  status: string | null;
  retryAt: string | null;
  reason: string | null;
};

export type AckResult = {
  ok: boolean;
  duplicate: boolean;
  jobStatus: string | null;
  resultId: string | null;
  reason: string | null;
};

export type HeartbeatDetails = Record<string, string | number | boolean | null>;

export type ClaimJobsInput = {
  workerId: string;
  region: string;
  leaseSeconds: number;
  batchSize: number;
  allowedHosts: string[];
};

export type QueueClientOptions = {
  connectionString: string;
  ssl: boolean;
  max?: number;
  onPoolError?: (error: unknown) => void;
};

export class QueueClientError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super("queue operation failed");
    this.name = "QueueClientError";
    this.code = code;
  }
}

function parseClaimedJob(value: unknown): ClaimedJob {
  const record = asRecord(value);
  return {
    jobId: asString(record.job_id, "job_id"),
    leaseToken: asString(record.lease_token, "lease_token"),
    monitorId: asString(record.monitor_id, "monitor_id"),
    region: asString(record.region, "region"),
    scheduledFor: asString(record.scheduled_for, "scheduled_for"),
    attempts: asNumber(record.attempts, "attempts"),
    maxAttempts: asNumber(record.max_attempts, "max_attempts"),
    url: asString(record.url, "url"),
    method: asEnum(record.method, "method", ["GET", "HEAD"] as const),
    expectedStatusCodes: asNumberArray(
      record.expected_status_codes,
      "expected_status_codes",
    ),
    timeoutSeconds: asNumber(record.timeout_seconds, "timeout_seconds"),
    verifyTls: asBoolean(record.verify_tls, "verify_tls"),
    followRedirects: asBoolean(record.follow_redirects, "follow_redirects"),
    maxRedirects: asNumber(record.max_redirects, "max_redirects"),
    hasRequestSecrets: asBoolean(record.has_request_secrets, "has_request_secrets"),
  };
}

export function parseClaimResult(value: unknown): ClaimResult {
  const record = asRecord(value);
  if (!Array.isArray(record.jobs)) throw new ProtocolError("jobs");
  return {
    jobs: record.jobs.map(parseClaimedJob),
    executionMode: asString(record.execution_mode, "execution_mode"),
    reason: asNullableString(record.reason, "reason"),
    claimedAt: asNullableString(record.claimed_at, "claimed_at"),
  };
}

export function parseExecutionStatus(value: unknown): ExecutionStatus {
  const record = asRecord(value);
  return {
    enabled: asBoolean(record.enabled, "enabled"),
    mode: asString(record.mode, "mode"),
    reason: asString(record.reason, "reason"),
    egressVerifiedAt: asNullableString(record.egress_verified_at, "egress_verified_at"),
    egressVerifiedBy: asNullableString(record.egress_verified_by, "egress_verified_by"),
  };
}

export function parseQueueMetrics(value: unknown): QueueMetrics {
  const record = asRecord(value);
  return {
    generatedAt: asNullableString(record.generated_at, "generated_at"),
    queueDepth: asNumber(record.queue_depth, "queue_depth"),
    leasedJobs: asNumber(record.leased_jobs, "leased_jobs"),
    completedJobs: asNumber(record.completed_jobs, "completed_jobs"),
    failedJobs: asNumber(record.failed_jobs, "failed_jobs"),
    retriedJobs: asNumber(record.retried_jobs, "retried_jobs"),
    expiredLeases: asNumber(record.expired_leases, "expired_leases"),
    oldestJobAgeSeconds: asNumber(
      record.oldest_job_age_seconds,
      "oldest_job_age_seconds",
    ),
    schedulerDelaySeconds: asNumber(
      record.scheduler_delay_seconds,
      "scheduler_delay_seconds",
    ),
    schedulerHeartbeatAgeSeconds: asNullableNumber(
      record.scheduler_heartbeat_age_seconds,
      "scheduler_heartbeat_age_seconds",
    ),
    workerHeartbeatAgeSeconds: asNullableNumber(
      record.worker_heartbeat_age_seconds,
      "worker_heartbeat_age_seconds",
    ),
    workerConcurrency: asNumber(record.worker_concurrency, "worker_concurrency"),
    timeoutResultsLastHour: asNumber(
      record.timeout_results_last_hour,
      "timeout_results_last_hour",
    ),
    checkDurationMsAvgLastHour: asNumber(
      record.check_duration_ms_avg_last_hour,
      "check_duration_ms_avg_last_hour",
    ),
  };
}

export function parseReapResult(value: unknown): ReapResult {
  const record = asRecord(value);
  return {
    recovered: asNumber(record.recovered, "recovered"),
    deadLettered: asNumber(record.dead_lettered, "dead_lettered"),
    reapedAt: asNullableString(record.reaped_at, "reaped_at"),
  };
}

function parseReleaseResult(value: unknown): ReleaseResult {
  const record = asRecord(value);
  return {
    ok: asBoolean(record.ok, "ok"),
    status: asNullableString(record.status, "status"),
    reason: asNullableString(record.reason, "reason"),
  };
}

function parseFailResult(value: unknown): FailResult {
  const record = asRecord(value);
  return {
    ok: asBoolean(record.ok, "ok"),
    status: asNullableString(record.status, "status"),
    retryAt: asNullableString(record.retry_at, "retry_at"),
    reason: asNullableString(record.reason, "reason"),
  };
}

function parseAckResult(value: unknown): AckResult {
  const record = asRecord(value);
  return {
    ok: asBoolean(record.ok, "ok"),
    duplicate: typeof record.duplicate === "boolean" ? record.duplicate : false,
    jobStatus: asNullableString(record.job_status, "job_status"),
    resultId: asNullableString(record.result_id, "result_id"),
    reason: asNullableString(record.reason, "reason"),
  };
}

export class QueueClient {
  private readonly pool: Pool;

  constructor(options: QueueClientOptions) {
    this.pool = createDbPool({
      connectionString: options.connectionString,
      ssl: options.ssl,
      applicationName: "onedash-worker-queue",
      max: options.max ?? 2,
      onError: options.onPoolError,
    });
  }

  private async queryResult(sql: string, params: unknown[]): Promise<unknown> {
    try {
      const result = await this.pool.query<{ result: unknown }>(sql, params);
      return result.rows[0]?.result;
    } catch (error) {
      throw new QueueClientError(pgErrorCode(error));
    }
  }

  async claimJobs(input: ClaimJobsInput): Promise<ClaimResult> {
    const value = await this.queryResult(
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [
        input.workerId,
        input.region,
        input.leaseSeconds,
        input.batchSize,
        input.allowedHosts,
      ],
    );
    return parseClaimResult(value);
  }

  async extendLease(
    jobId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const value = await this.queryResult(
      "select public.onedash_extend_lease($1, $2, $3) as result",
      [jobId, leaseToken, leaseSeconds],
    );
    return asBoolean(asRecord(value).ok, "ok");
  }

  async releaseJob(jobId: string, leaseToken: string): Promise<ReleaseResult> {
    const value = await this.queryResult(
      "select public.onedash_release_job($1, $2) as result",
      [jobId, leaseToken],
    );
    return parseReleaseResult(value);
  }

  async failJob(
    jobId: string,
    leaseToken: string,
    errorClass: JobErrorClass,
    retryable: boolean,
  ): Promise<FailResult> {
    const value = await this.queryResult(
      "select public.onedash_fail_job($1, $2, $3, $4) as result",
      [jobId, leaseToken, errorClass, retryable],
    );
    return parseFailResult(value);
  }

  async reapExpiredLeases(limit: number): Promise<ReapResult> {
    const value = await this.queryResult(
      "select public.onedash_reap_expired_leases($1) as result",
      [limit],
    );
    return parseReapResult(value);
  }

  async acknowledgeJob(jobId: string, leaseToken: string): Promise<AckResult> {
    const value = await this.queryResult(
      "select public.onedash_acknowledge_job($1, $2) as result",
      [jobId, leaseToken],
    );
    return parseAckResult(value);
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
      throw new QueueClientError(pgErrorCode(error));
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
