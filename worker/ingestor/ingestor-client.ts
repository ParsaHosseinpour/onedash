import type { Pool } from "pg";
import { createDbPool, pgErrorCode } from "../db";
import {
  asBoolean,
  asNullableString,
  asRecord,
} from "../protocol";
import type { IngestCheckResult } from "./result-payload";

export type IngestResult = {
  ok: boolean;
  duplicate: boolean;
  jobStatus: string | null;
  resultId: string | null;
  monitorStatus: string | null;
  reason: string | null;
};

export type IngestorAckResult = {
  ok: boolean;
  duplicate: boolean;
  jobStatus: string | null;
  resultId: string | null;
  reason: string | null;
};

export type IngestorClientOptions = {
  connectionString: string;
  ssl: boolean;
  max?: number;
  onPoolError?: (error: unknown) => void;
};

export class IngestorClientError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super("ingestor operation failed");
    this.name = "IngestorClientError";
    this.code = code;
  }
}

function parseIngestResult(value: unknown): IngestResult {
  const record = asRecord(value);
  return {
    ok: asBoolean(record.ok, "ok"),
    duplicate: typeof record.duplicate === "boolean" ? record.duplicate : false,
    jobStatus: asNullableString(record.job_status, "job_status"),
    resultId: asNullableString(record.result_id, "result_id"),
    monitorStatus: asNullableString(record.monitor_status, "monitor_status"),
    reason: asNullableString(record.reason, "reason"),
  };
}

function parseAckResult(value: unknown): IngestorAckResult {
  const record = asRecord(value);
  return {
    ok: asBoolean(record.ok, "ok"),
    duplicate: typeof record.duplicate === "boolean" ? record.duplicate : false,
    jobStatus: asNullableString(record.job_status, "job_status"),
    resultId: asNullableString(record.result_id, "result_id"),
    reason: asNullableString(record.reason, "reason"),
  };
}

export class IngestorClient {
  private readonly pool: Pool;

  constructor(options: IngestorClientOptions) {
    this.pool = createDbPool({
      connectionString: options.connectionString,
      ssl: options.ssl,
      applicationName: "onedash-worker-ingestor",
      max: options.max ?? 2,
      onError: options.onPoolError,
    });
  }

  private async queryResult(sql: string, params: unknown[]): Promise<unknown> {
    try {
      const result = await this.pool.query<{ result: unknown }>(sql, params);
      return result.rows[0]?.result;
    } catch (error) {
      throw new IngestorClientError(pgErrorCode(error));
    }
  }

  async ingest(
    jobId: string,
    leaseToken: string,
    result: IngestCheckResult,
  ): Promise<IngestResult> {
    const value = await this.queryResult(
      "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
      [jobId, leaseToken, JSON.stringify(result)],
    );
    return parseIngestResult(value);
  }

  async acknowledge(jobId: string, leaseToken: string): Promise<IngestorAckResult> {
    const value = await this.queryResult(
      "select public.onedash_acknowledge_job($1, $2) as result",
      [jobId, leaseToken],
    );
    return parseAckResult(value);
  }

  async ping(): Promise<void> {
    try {
      await this.pool.query("select 1");
    } catch (error) {
      throw new IngestorClientError(pgErrorCode(error));
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
