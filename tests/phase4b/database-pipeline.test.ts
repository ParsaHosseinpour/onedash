import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { SAFE_MESSAGES } from "../../worker/checker";
import { createFixtureChecker } from "../../worker/checker/adapter";
import { IngestorClient } from "../../worker/ingestor/ingestor-client";
import { createSilentLogger } from "../../worker/logging";
import { QueueClient } from "../../worker/queue/queue-client";
import { SchedulerClient } from "../../worker/scheduler/scheduler-client";
import { WorkerRuntime } from "../../worker/service/worker-runtime";

const ADMIN_URL =
  process.env.ONEDASH_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const TEST_PASSWORD = "phase4b_test_password";
const TEST_ROLES = [
  "onedash_test_scheduler",
  "onedash_test_queue",
  "onedash_test_ingestor",
] as const;
const TEST_MONITOR_ID = "d4b00000-0000-4000-8000-000000000001";
const TEST_MONITOR_ID_2 = "d4b00000-0000-4000-8000-000000000002";
const TEST_MONITOR_ID_3 = "d4b00000-0000-4000-8000-000000000003";
const TEST_MONITOR_ID_4 = "d4b00000-0000-4000-8000-000000000004";
const TEST_MONITOR_ID_5 = "d4b00000-0000-4000-8000-000000000005";
const TEST_MONITOR_ID_6 = "d4b00000-0000-4000-8000-000000000006";
const TEST_REGION = "test-1";
const TEST_REGION_2 = "test-2";
const TEST_HOST = "phase4b-fixture.test";
const TEST_URL = `https://${TEST_HOST}/health`;
const TEST_WORKER_ID = "phase4b-worker";
const TEST_HEARTBEAT_IDS = [
  "integration-scheduler",
  TEST_WORKER_ID,
  "phase4b-runtime-worker",
  "phase4b-cleanup-heartbeat",
  "phase4b-nested-heartbeat",
] as const;

function roleUrl(role: string): string {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = TEST_PASSWORD;
  return url.toString();
}

async function jsonResult<T>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const result = await client.query(sql, params);
  return result.rows[0].result as T;
}

async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

type ScheduleResult = {
  scheduled: number;
  execution_mode?: string;
  reason?: string;
};

type ClaimedJob = {
  job_id: string;
  lease_token: string;
  attempts: number;
  max_attempts: number;
  url: string;
  method: string;
  expected_status_codes: number[];
  timeout_seconds: number;
  verify_tls: boolean;
  follow_redirects: boolean;
  max_redirects: number;
  has_request_secrets: boolean;
};

type ClaimResult = {
  execution_mode: string;
  jobs: ClaimedJob[];
  reason?: string;
};

type FailResult = {
  ok: boolean;
  status: string;
  retry_at: string;
};

type ReapResult = {
  recovered: number;
  dead_lettered: number;
};

type IngestResult = {
  ok: boolean;
  duplicate: boolean;
  job_status: string;
  monitor_status: string;
  result_id: string;
  reason?: string;
};

type MetricsResult = {
  queue_depth: number;
  leased_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  worker_concurrency: number;
  retried_jobs: number;
  expired_leases: number;
  scheduler_heartbeat_age_seconds: number | null;
  worker_heartbeat_age_seconds: number | null;
  check_duration_ms_avg_last_hour: number;
};

type ExecutionStatusResult = {
  enabled: boolean;
  mode: string;
  reason?: string;
};

type ExecutionSettings = {
  execution_enabled: boolean;
  mode: string;
  reason: string;
  egress_verified_at: Date | null;
  egress_verified_by: string | null;
};

type AckResult = {
  ok: boolean;
  duplicate?: boolean;
  job_status?: string;
  result_id?: string;
  reason?: string;
};

type ReleaseResult = {
  ok: boolean;
  status?: string;
  reason?: string;
};

async function insertPendingJob(
  monitorId: string,
  key: string,
  options: {
    region?: string;
    offsetSeconds?: number;
    maxAttempts?: number;
  } = {},
): Promise<string> {
  const result = await admin!.query(
    `insert into public.check_jobs (
       organization_id, monitor_id, region, scheduled_for, available_at,
       idempotency_key, status, max_attempts
     )
     select
       organization_id,
       id,
       $2,
       now() + make_interval(secs => $3),
       now() + make_interval(secs => $3),
       $4,
       'pending',
       $5
     from public.monitors
     where id = $1
     returning id`,
    [
      monitorId,
      options.region ?? TEST_REGION_2,
      options.offsetSeconds ?? 0,
      key,
      options.maxAttempts ?? 5,
    ],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0].id as string;
}

async function claimFrom(
  client: Client,
  workerId: string,
  batchSize: number,
  region = TEST_REGION_2,
): Promise<ClaimResult> {
  return jsonResult<ClaimResult>(
    client,
    "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
    [workerId, region, 60, batchSize, [TEST_HOST]],
  );
}

async function cleanupNewMonitors(): Promise<void> {
  const ids = [TEST_MONITOR_ID_4, TEST_MONITOR_ID_5, TEST_MONITOR_ID_6];
  await admin!.query(
    "delete from public.check_jobs where monitor_id = any($1::uuid[])",
    [ids],
  );
  await admin!.query(
    "delete from public.check_results where monitor_id = any($1::uuid[])",
    [ids],
  );
  await admin!.query(
    "delete from public.monitor_state where monitor_id = any($1::uuid[])",
    [ids],
  );
  await admin!.query(
    "delete from public.monitor_schedules where monitor_id = any($1::uuid[]) and region = $2",
    [ids, TEST_REGION_2],
  );
}

type ResultPayload = {
  status: string;
  http_status: number | null;
  response_time_ms: number;
  dns_ms: number | null;
  connect_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  total_ms: number;
  error_class: string | null;
  error_message: string | null;
  redirect_count: number;
  response_bytes: number | null;
  checked_at: string;
};

function ingestPayload(
  overrides: Partial<ResultPayload> = {},
): ResultPayload {
  return {
    ...payload,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

async function ingestResult(
  client: Client,
  job: string,
  token: string,
  result: ResultPayload,
): Promise<IngestResult> {
  return jsonResult<IngestResult>(
    client,
    "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
    [job, token, JSON.stringify(result)],
  );
}

let admin: Client | null = null;
let scheduler: Client | null = null;
let scheduler2: Client | null = null;
let queue: Client | null = null;
let queue2: Client | null = null;
let ingestor: Client | null = null;
let ingestor2: Client | null = null;

let originalSettings: ExecutionSettings | null = null;
let savedSchedules: Array<{ id: string; next_run_at: Date }> = [];

let jobId = "";
let leaseToken = "";
let job2Id = "";
let job2Token = "";
let job3Id = "";
let job3Token = "";

const payload = {
  status: "up",
  http_status: 200,
  response_time_ms: 123,
  dns_ms: 4,
  connect_ms: 8,
  tls_ms: 12,
  ttfb_ms: 20,
  total_ms: 130,
  error_class: null,
  error_message: null,
  redirect_count: 0,
  response_bytes: 512,
  checked_at: new Date().toISOString(),
};

beforeAll(async () => {
  admin = new Client({
    connectionString: ADMIN_URL,
    application_name: "phase4b-test-admin",
  });
  await admin.connect();

  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where usename = any($1::text[]) and pid <> pg_backend_pid()",
    [TEST_ROLES],
  );

  for (const role of TEST_ROLES) {
    await admin.query(`drop role if exists ${role}`);
  }

  await admin.query(
    `create role onedash_test_scheduler login password '${TEST_PASSWORD}' in role onedash_scheduler`,
  );
  await admin.query(
    `create role onedash_test_queue login password '${TEST_PASSWORD}' in role onedash_queue`,
  );
  await admin.query(
    `create role onedash_test_ingestor login password '${TEST_PASSWORD}' in role onedash_ingestor`,
  );

  scheduler = new Client({ connectionString: roleUrl("onedash_test_scheduler") });
  scheduler2 = new Client({ connectionString: roleUrl("onedash_test_scheduler") });
  queue = new Client({ connectionString: roleUrl("onedash_test_queue") });
  queue2 = new Client({ connectionString: roleUrl("onedash_test_queue") });
  ingestor = new Client({ connectionString: roleUrl("onedash_test_ingestor") });
  ingestor2 = new Client({ connectionString: roleUrl("onedash_test_ingestor") });
  await Promise.all([
    scheduler.connect(),
    scheduler2.connect(),
    queue.connect(),
    queue2.connect(),
    ingestor.connect(),
    ingestor2.connect(),
  ]);

  await admin.query("delete from public.monitors where id = any($1::uuid[])", [
    [
      TEST_MONITOR_ID,
      TEST_MONITOR_ID_2,
      TEST_MONITOR_ID_3,
      TEST_MONITOR_ID_4,
      TEST_MONITOR_ID_5,
      TEST_MONITOR_ID_6,
    ],
  ]);

  const inserted = await admin.query(
    `insert into public.monitors (
       id, organization_id, name, url, method, expected_status_codes,
       interval_seconds, timeout_seconds, is_active
     )
     select $1, o.id, 'Phase 4B fixture', $2, 'GET', array[200], 300, 5, true
     from public.organizations o
     where o.slug = 'acme-monitoring'`,
    [TEST_MONITOR_ID, TEST_URL],
  );
  expect(inserted.rowCount).toBe(1);

  await admin.query(
    `insert into public.monitor_execution_allowlist (
       monitor_id, organization_id, url, reason
     )
     select id, organization_id, url, 'phase4b integration test'
     from public.monitors
     where id = $1`,
    [TEST_MONITOR_ID],
  );

  await admin.query(
    `insert into public.monitors (
       id, organization_id, name, url, method, expected_status_codes,
       interval_seconds, timeout_seconds, is_active
     )
     select
       v.id,
       o.id,
       v.name,
       v.url,
       'GET',
       array[200],
       300,
       5,
       true
     from (
       values
         ($1::uuid, 'acme-monitoring', 'Concurrency fixture', $2),
         ($3::uuid, 'globex-status', 'Second tenant fixture', $4),
         ($5::uuid, 'acme-monitoring', 'Isolation control fixture', $6)
     ) as v(id, org_slug, name, url)
     join public.organizations o on o.slug = v.org_slug`,
    [
      TEST_MONITOR_ID_4,
      `https://${TEST_HOST}/concurrency`,
      TEST_MONITOR_ID_5,
      `https://${TEST_HOST}/tenant`,
      TEST_MONITOR_ID_6,
      `https://${TEST_HOST}/control`,
    ],
  );

  await admin.query(
    `insert into public.monitor_execution_allowlist (
       monitor_id, organization_id, url, reason
     )
     select id, organization_id, url, 'phase4b integration test'
     from public.monitors
     where id = any($1::uuid[])`,
    [[TEST_MONITOR_ID_4, TEST_MONITOR_ID_5]],
  );

  await admin.query(
    `insert into public.monitor_schedules (
       organization_id, monitor_id, region, next_run_at
     )
     select organization_id, id, $2, now() - interval '1 minute'
     from public.monitors
     where id = $1`,
    [TEST_MONITOR_ID, TEST_REGION],
  );

  const settings = await admin.query(
    "select * from public.monitor_execution_settings where singleton",
  );
  originalSettings = settings.rows[0] ?? null;
  await admin.query(
    `update public.monitor_execution_settings
     set mode = 'fixtures',
         execution_enabled = true,
         reason = 'phase4b integration test',
         egress_verified_at = null,
         egress_verified_by = null
     where singleton`,
  );

  const saved = await admin.query(
    `select id, next_run_at
     from public.monitor_schedules
     where monitor_id <> $1 and next_run_at is not null`,
    [TEST_MONITOR_ID],
  );
  savedSchedules = saved.rows;
  await admin.query(
    `update public.monitor_schedules
     set next_run_at = now() + interval '1 hour'
     where monitor_id <> $1 and next_run_at is not null`,
    [TEST_MONITOR_ID],
  );
});

afterAll(async () => {
  await Promise.allSettled([
    scheduler?.end(),
    scheduler2?.end(),
    queue?.end(),
    queue2?.end(),
    ingestor?.end(),
    ingestor2?.end(),
  ]);

  const cleanupFailures: string[] = [];
  let cleanupAdmin: Client | null = null;

  // Use a fresh privileged connection so cleanup still runs after a test
  // failure or a broken shared admin connection.
  try {
    cleanupAdmin = new Client({
      connectionString: ADMIN_URL,
      application_name: "phase4b-test-cleanup",
    });
    await cleanupAdmin.connect();
  } catch (error) {
    cleanupFailures.push(`connect cleanup client: ${String(error)}`);
  }

  const runCleanup = async (
    label: string,
    action: (client: Client) => Promise<unknown>,
  ): Promise<void> => {
    if (!cleanupAdmin) return;
    try {
      await action(cleanupAdmin);
    } catch (error) {
      cleanupFailures.push(`${label}: ${String(error)}`);
    }
  };

  try {
    await runCleanup("restore execution settings", async (client) => {
      if (!originalSettings) return;
      await client.query(
        `update public.monitor_execution_settings
         set execution_enabled = $1,
             mode = $2,
             reason = $3,
             egress_verified_at = $4,
             egress_verified_by = $5
         where singleton`,
        [
          originalSettings.execution_enabled,
          originalSettings.mode,
          originalSettings.reason,
          originalSettings.egress_verified_at,
          originalSettings.egress_verified_by,
        ],
      );
    });

    await runCleanup("restore schedules", async (client) => {
      for (const row of savedSchedules) {
        await client.query(
          "update public.monitor_schedules set next_run_at = $2 where id = $1",
          [row.id, row.next_run_at],
        );
      }
    });

    await runCleanup("delete test monitors", async (client) => {
      await client.query(
        "delete from public.monitors where id = any($1::uuid[])",
        [
          [
            TEST_MONITOR_ID,
            TEST_MONITOR_ID_2,
            TEST_MONITOR_ID_3,
            TEST_MONITOR_ID_4,
            TEST_MONITOR_ID_5,
            TEST_MONITOR_ID_6,
          ],
        ],
      );
    });

    // Delete only the instance ids created by this suite. Active production
    // or developer heartbeats with any other id are left untouched.
    await runCleanup("delete test heartbeat records", async (client) => {
      await client.query(
        "delete from public.service_heartbeats where instance_id = any($1::text[])",
        [TEST_HEARTBEAT_IDS],
      );
    });

    await runCleanup("verify heartbeat cleanup", async (client) => {
      const remaining = await client.query(
        `select count(*)::int as count
         from public.service_heartbeats
         where instance_id = any($1::text[])`,
        [TEST_HEARTBEAT_IDS],
      );
      if (remaining.rows[0].count !== 0) {
        throw new Error(
          `${remaining.rows[0].count} test heartbeat rows remain after cleanup`,
        );
      }
    });

    await runCleanup("terminate test roles", async (client) => {
      await client.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where usename = any($1::text[]) and pid <> pg_backend_pid()",
        [TEST_ROLES],
      );
    });
    for (const role of TEST_ROLES) {
      await runCleanup(`drop role ${role}`, async (client) => {
        await client.query(`drop role if exists ${role}`);
      });
    }
  } finally {
    if (cleanupAdmin) {
      await cleanupAdmin.end().catch(() => undefined);
    }
    if (admin) {
      await admin.end().catch(() => undefined);
    }
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`Phase 4B cleanup failed: ${cleanupFailures.join("; ")}`);
  }
});

describe("Phase 4B scheduler, queue, and ingestion", () => {
  it("creates exactly one job with concurrent schedulers and claims it safely", async () => {
    await admin!.query(
      `update public.monitor_schedules
       set next_run_at = now() - interval '1 minute'
       where monitor_id = $1 and region = $2`,
      [TEST_MONITOR_ID, TEST_REGION],
    );

    const [first, second] = await Promise.all([
      jsonResult<ScheduleResult>(
        scheduler!,
        "select public.onedash_schedule_due_jobs($1, $2) as result",
        [10, 0],
      ),
      jsonResult<ScheduleResult>(
        scheduler2!,
        "select public.onedash_schedule_due_jobs($1, $2) as result",
        [10, 0],
      ),
    ]);
    expect(Number(first.scheduled) + Number(second.scheduled)).toBe(1);

    const jobs = await admin!.query(
      "select * from public.check_jobs where monitor_id = $1 and region = $2",
      [TEST_MONITOR_ID, TEST_REGION],
    );
    expect(jobs.rowCount).toBe(1);
    const job = jobs.rows[0];
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.max_attempts).toBe(5);
    expect(job.idempotency_key).toMatch(
      new RegExp(`^sched:${TEST_MONITOR_ID}:${TEST_REGION}:`),
    );
    expect(new Date(job.available_at).toISOString()).toBe(
      new Date(job.scheduled_for).toISOString(),
    );

    const claim = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(claim.execution_mode).toBe("fixtures");
    expect(claim.jobs).toHaveLength(1);
    const claimed = claim.jobs[0];
    expect(claimed.job_id).toBe(job.id);
    expect(claimed.attempts).toBe(1);
    expect(claimed.max_attempts).toBe(5);
    expect(claimed.url).toBe(TEST_URL);
    expect(claimed.method).toBe("GET");
    expect(claimed.expected_status_codes).toEqual([200]);
    expect(claimed.timeout_seconds).toBe(5);
    expect(claimed.verify_tls).toBe(true);
    expect(claimed.follow_redirects).toBe(false);
    expect(claimed.max_redirects).toBe(0);
    expect(claimed.has_request_secrets).toBe(false);

    jobId = claimed.job_id;
    leaseToken = claimed.lease_token;

    const noSecondClaim = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(noSecondClaim.jobs).toHaveLength(0);
  });

  it("enforces split permissions and removes the legacy worker grants", async () => {
    await expectPgError(
      scheduler!.query(
        "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[])",
        [TEST_WORKER_ID, TEST_REGION, 60, 1, [TEST_HOST]],
      ),
      "42501",
    );
    await expectPgError(
      queue!.query(
        "select public.onedash_ingest_check_result($1, $2, $3::jsonb)",
        [jobId, leaseToken, JSON.stringify(payload)],
      ),
      "42501",
    );
    await expectPgError(
      ingestor!.query(
        "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[])",
        [TEST_WORKER_ID, TEST_REGION, 60, 1, [TEST_HOST]],
      ),
      "42501",
    );
    await expectPgError(
      scheduler!.query("select count(*) from public.check_jobs"),
      "42501",
    );
    await expectPgError(
      queue!.query("select count(*) from public.monitors"),
      "42501",
    );
    await expectPgError(
      ingestor!.query("select count(*) from public.check_results"),
      "42501",
    );

    const privileges = await admin!.query(
      `select
         has_table_privilege('onedash_worker', 'public.monitors', 'SELECT') as worker_monitors,
         has_table_privilege('onedash_worker', 'public.check_jobs', 'SELECT') as worker_jobs,
         has_function_privilege(
           'onedash_worker',
           'public.onedash_claim_jobs(text,text,integer,integer,text[])',
           'EXECUTE'
         ) as worker_claim,
         has_table_privilege('onedash_scheduler', 'public.check_jobs', 'SELECT') as scheduler_jobs,
         has_table_privilege('onedash_queue', 'public.check_jobs', 'SELECT') as queue_jobs,
         has_table_privilege('onedash_ingestor', 'public.check_results', 'SELECT') as ingestor_results`,
    );
    // PUBLIC retains USAGE on schema public, so the legacy role still inherits
    // schema visibility. It has no direct table or function privileges.
    expect(privileges.rows[0]).toMatchObject({
      worker_monitors: false,
      worker_jobs: false,
      worker_claim: false,
      scheduler_jobs: false,
      queue_jobs: false,
      ingestor_results: false,
    });

    const login = await admin!.query(
      "select rolcanlogin from pg_roles where rolname = 'onedash_worker'",
    );
    expect(login.rows[0].rolcanlogin).toBe(false);
  });

  it("stores a checker result idempotently and updates monitor state", async () => {
    const ingest = await jsonResult<IngestResult>(
      ingestor!,
      "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
      [jobId, leaseToken, JSON.stringify(payload)],
    );
    expect(ingest.ok).toBe(true);
    expect(ingest.duplicate).toBe(false);
    expect(ingest.job_status).toBe("completed");
    expect(ingest.monitor_status).toBe("up");
    expect(typeof ingest.result_id).toBe("string");

    const job = await admin!.query(
      "select * from public.check_jobs where id = $1",
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({
      status: "completed",
      result_id: ingest.result_id,
    });
    expect(job.rows[0].completed_at).not.toBeNull();
    expect(job.rows[0].lease_owner).toBeNull();
    expect(job.rows[0].lease_token).toBeNull();
    expect(job.rows[0].lease_expires_at).toBeNull();

    const results = await admin!.query(
      "select * from public.check_results where monitor_id = $1",
      [TEST_MONITOR_ID],
    );
    expect(results.rowCount).toBe(1);
    const result = results.rows[0];
    expect(result).toMatchObject({
      organization_id: job.rows[0].organization_id,
      monitor_id: TEST_MONITOR_ID,
      region: TEST_REGION,
      status: "up",
      http_status: 200,
      response_time_ms: 123,
      dns_ms: 4,
      connect_ms: 8,
      tls_ms: 12,
      ttfb_ms: 20,
      total_ms: 130,
      error_class: null,
      error_message: null,
      redirect_count: 0,
      response_bytes: 512,
      idempotency_key: job.rows[0].idempotency_key,
    });
    expect(new Date(result.scheduled_at).toISOString()).toBe(
      new Date(job.rows[0].scheduled_for).toISOString(),
    );

    const state = await admin!.query(
      "select * from public.monitor_state where monitor_id = $1",
      [TEST_MONITOR_ID],
    );
    expect(state.rowCount).toBe(1);
    expect(state.rows[0]).toMatchObject({
      status: "up",
      consecutive_failures: 0,
      consecutive_successes: 1,
      open_incident_id: null,
    });
    expect(new Date(state.rows[0].last_checked_at).toISOString()).toBe(
      new Date(payload.checked_at).toISOString(),
    );

    const duplicate = await jsonResult<IngestResult>(
      ingestor!,
      "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
      [jobId, leaseToken, JSON.stringify(payload)],
    );
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.result_id).toBe(ingest.result_id);

    const duplicateResults = await admin!.query(
      "select count(*)::int as count from public.check_results where monitor_id = $1",
      [TEST_MONITOR_ID],
    );
    expect(duplicateResults.rows[0].count).toBe(1);

    const duplicateState = await admin!.query(
      "select consecutive_successes from public.monitor_state where monitor_id = $1",
      [TEST_MONITOR_ID],
    );
    expect(duplicateState.rows[0].consecutive_successes).toBe(1);

    await expectPgError(
      ingestor!.query(
        "select public.onedash_ingest_check_result($1, $2, $3::jsonb)",
        [
          jobId,
          leaseToken,
          JSON.stringify({ ...payload, monitor_id: TEST_MONITOR_ID_2 }),
        ],
      ),
      "22023",
    );

    const wrongToken = await jsonResult<IngestResult>(
      ingestor!,
      "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
      [jobId, "00000000-0000-4000-8000-000000000099", JSON.stringify(payload)],
    );
    expect(wrongToken).toMatchObject({ ok: false, reason: "lease_mismatch" });
  });

  it("retries with exponential backoff and dead-letters a terminal failure", async () => {
    await admin!.query(
      `update public.monitor_schedules
       set next_run_at = now() - interval '2 minutes'
       where monitor_id = $1 and region = $2`,
      [TEST_MONITOR_ID, TEST_REGION],
    );
    const schedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(schedule.scheduled).toBe(1);

    const pending = await admin!.query(
      `select * from public.check_jobs
       where monitor_id = $1 and region = $2 and status = 'pending'
       order by scheduled_for desc
       limit 1`,
      [TEST_MONITOR_ID, TEST_REGION],
    );
    expect(pending.rowCount).toBe(1);
    job2Id = pending.rows[0].id;

    const claim = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(claim.jobs).toHaveLength(1);
    expect(claim.jobs[0].job_id).toBe(job2Id);
    expect(claim.jobs[0].attempts).toBe(1);
    job2Token = claim.jobs[0].lease_token;

    const fail1 = await jsonResult<FailResult>(
      queue!,
      "select public.onedash_fail_job($1, $2, $3, $4) as result",
      [job2Id, job2Token, "timeout", true],
    );
    expect(fail1).toMatchObject({ ok: true, status: "pending" });
    expect(new Date(fail1.retry_at).getTime()).toBeGreaterThan(Date.now());

    const immediate = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(immediate.jobs).toHaveLength(0);

    await admin!.query(
      "update public.check_jobs set available_at = now() - interval '1 second' where id = $1",
      [job2Id],
    );

    const claim2 = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(claim2.jobs).toHaveLength(1);
    expect(claim2.jobs[0].job_id).toBe(job2Id);
    expect(claim2.jobs[0].attempts).toBe(2);
    job2Token = claim2.jobs[0].lease_token;

    const fail2 = await jsonResult<FailResult>(
      queue!,
      "select public.onedash_fail_job($1, $2, $3, $4) as result",
      [job2Id, job2Token, "worker_error", false],
    );
    expect(fail2).toMatchObject({ ok: true, status: "dead_letter" });

    const terminal = await admin!.query(
      "select * from public.check_jobs where id = $1",
      [job2Id],
    );
    expect(terminal.rows[0]).toMatchObject({
      status: "dead_letter",
      last_error_class: "worker_error",
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(terminal.rows[0].dead_letter_at).not.toBeNull();
    expect(terminal.rows[0].completed_at).toBeNull();

    const rejected = await jsonResult<IngestResult>(
      ingestor!,
      "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
      [job2Id, job2Token, JSON.stringify(payload)],
    );
    expect(rejected).toMatchObject({
      ok: false,
      reason: "lease_mismatch_or_expired",
    });
  });

  it("recovers an expired lease and dead-letters an exhausted job", async () => {
    await admin!.query(
      `update public.monitor_schedules
       set next_run_at = now() - interval '3 minutes'
       where monitor_id = $1 and region = $2`,
      [TEST_MONITOR_ID, TEST_REGION],
    );
    const schedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(schedule.scheduled).toBe(1);

    const pending = await admin!.query(
      `select * from public.check_jobs
       where monitor_id = $1 and region = $2 and status = 'pending'
       order by scheduled_for desc
       limit 1`,
      [TEST_MONITOR_ID, TEST_REGION],
    );
    job3Id = pending.rows[0].id;

    const claim = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 30, 5, [TEST_HOST]],
    );
    expect(claim.jobs).toHaveLength(1);
    expect(claim.jobs[0].job_id).toBe(job3Id);
    job3Token = claim.jobs[0].lease_token;

    await admin!.query(
      "update public.check_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [job3Id],
    );

    const reap = await jsonResult<ReapResult>(
      scheduler!,
      "select public.onedash_reap_expired_leases($1) as result",
      [10],
    );
    expect(reap.recovered).toBeGreaterThanOrEqual(1);

    const recovered = await admin!.query(
      "select * from public.check_jobs where id = $1",
      [job3Id],
    );
    expect(recovered.rows[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lease_expired_count: 1,
      last_error_class: "lease_expired",
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(new Date(recovered.rows[0].available_at).getTime()).toBeGreaterThan(
      Date.now(),
    );

    await admin!.query(
      `update public.check_jobs
       set status = 'leased',
           attempts = max_attempts,
           lease_owner = 'test-reaper',
           lease_token = gen_random_uuid(),
           lease_expires_at = now() - interval '1 second'
       where id = $1`,
      [job3Id],
    );

    const reap2 = await jsonResult<ReapResult>(
      scheduler!,
      "select public.onedash_reap_expired_leases($1) as result",
      [10],
    );
    expect(reap2.dead_lettered).toBeGreaterThanOrEqual(1);

    const dead = await admin!.query(
      "select * from public.check_jobs where id = $1",
      [job3Id],
    );
    expect(dead.rows[0]).toMatchObject({
      status: "dead_letter",
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
    });
    expect(dead.rows[0].dead_letter_at).not.toBeNull();
    expect(dead.rows[0].completed_at).toBeNull();

    const rejected = await jsonResult<IngestResult>(
      ingestor!,
      "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
      [job3Id, job3Token, JSON.stringify(payload)],
    );
    expect(rejected).toMatchObject({
      ok: false,
      reason: "lease_mismatch_or_expired",
    });
  });

  it("refuses scheduling and claiming when the execution gate is disabled or customer", async () => {
    await admin!.query(
      `update public.monitor_execution_settings
       set mode = 'disabled',
           execution_enabled = false,
           reason = 'integration disabled',
           egress_verified_at = null,
           egress_verified_by = null
       where singleton`,
    );

    const disabledSchedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(disabledSchedule).toMatchObject({
      scheduled: 0,
      execution_mode: "disabled",
    });
    const disabledClaim = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(disabledClaim.jobs).toHaveLength(0);
    expect(disabledClaim.execution_mode).toBe("disabled");

    await admin!.query(
      `update public.monitor_execution_settings
       set mode = 'customer',
           execution_enabled = true,
           reason = 'integration customer',
           egress_verified_at = now(),
           egress_verified_by = 'integration test'
       where singleton`,
    );

    const customerSchedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(customerSchedule.scheduled).toBe(0);
    expect(customerSchedule.execution_mode).toBe("customer");
    expect(customerSchedule.reason).toMatch(/not implemented/);

    const customerClaim = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(customerClaim.jobs).toHaveLength(0);
    expect(customerClaim.execution_mode).toBe("customer");
    expect(customerClaim.reason).toMatch(/not implemented/);

    const status = await jsonResult<ExecutionStatusResult>(
      scheduler!,
      "select public.onedash_execution_status() as result",
    );
    expect(status).toMatchObject({ enabled: true, mode: "customer" });

    await admin!.query(
      `update public.monitor_execution_settings
       set mode = 'fixtures',
           execution_enabled = true,
           reason = 'phase4b integration test',
           egress_verified_at = null,
           egress_verified_by = null
       where singleton`,
    );
  });

  it("records heartbeats and exposes aggregate metrics without customer data", async () => {
    await scheduler!.query(
      "select public.onedash_record_heartbeat($1, $2, $3, $4::jsonb)",
      [
        "scheduler",
        "integration-scheduler",
        "global",
        JSON.stringify({
          batch_size: 10,
          jitter_seconds: 0,
          last_scheduled: 0,
          last_skipped: 0,
          execution_mode: "fixtures",
        }),
      ],
    );

    await queue!.query(
      "select public.onedash_record_heartbeat($1, $2, $3, $4::jsonb)",
      [
        "worker",
        TEST_WORKER_ID,
        TEST_REGION,
        JSON.stringify({
          concurrency: 2,
          in_flight: 0,
          claimed_total: 2,
          completed_total: 1,
          failed_total: 2,
          retried_total: 2,
          last_error_class: "timeout",
        }),
      ],
    );

    const metrics = await jsonResult<MetricsResult>(
      ingestor!,
      "select public.onedash_queue_metrics() as result",
    );
    expect(metrics).toMatchObject({
      queue_depth: 0,
      leased_jobs: 0,
      completed_jobs: 1,
      failed_jobs: 2,
      worker_concurrency: 2,
    });
    expect(metrics.retried_jobs).toBeGreaterThanOrEqual(1);
    expect(metrics.expired_leases).toBeGreaterThanOrEqual(1);
    expect(metrics.scheduler_heartbeat_age_seconds).not.toBeNull();
    expect(metrics.worker_heartbeat_age_seconds).not.toBeNull();
    expect(metrics.check_duration_ms_avg_last_hour).toBeGreaterThanOrEqual(0);
    expect(metrics).not.toHaveProperty("url");
    expect(metrics).not.toHaveProperty("monitor_id");
    expect(metrics).not.toHaveProperty("organization_id");
    expect(JSON.stringify(metrics)).not.toContain(TEST_HOST);

    await expectPgError(
      scheduler!.query(
        "select public.onedash_record_heartbeat($1, $2, $3, $4::jsonb)",
        [
          "scheduler",
          "bad-heartbeat",
          "global",
          JSON.stringify({ url: "https://customer.example/private" }),
        ],
      ),
      "22023",
    );
  });

  it("enforces the worker fixture host allowlist and the database allowlist", async () => {
    await admin!.query(
      `update public.monitor_schedules
       set next_run_at = now() - interval '4 minutes'
       where monitor_id = $1 and region = $2`,
      [TEST_MONITOR_ID, TEST_REGION],
    );
    const schedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(schedule.scheduled).toBe(1);

    const wrongHost = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, ["other.test"]],
    );
    expect(wrongHost.jobs).toHaveLength(0);

    const rightHost = await jsonResult<ClaimResult>(
      queue!,
      "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
      [TEST_WORKER_ID, TEST_REGION, 60, 5, [TEST_HOST]],
    );
    expect(rightHost.jobs).toHaveLength(1);

    await admin!.query(
      `insert into public.monitors (
         id, organization_id, name, url, method, expected_status_codes,
         interval_seconds, timeout_seconds, is_active
       )
       select $1, organization_id, 'Not allowlisted',
              'https://not-allowlisted.test/health', 'GET', array[200], 300, 5, true
       from public.monitors
       where id = $2`,
      [TEST_MONITOR_ID_2, TEST_MONITOR_ID],
    );
    await admin!.query(
      `insert into public.monitor_schedules (
         organization_id, monitor_id, region, next_run_at
       )
       select organization_id, id, $2, now() - interval '1 minute'
       from public.monitors
       where id = $1`,
      [TEST_MONITOR_ID_2, TEST_REGION],
    );

    const notAllowlisted = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(notAllowlisted.scheduled).toBe(0);

    const jobs = await admin!.query(
      "select count(*)::int as count from public.check_jobs where monitor_id = $1",
      [TEST_MONITOR_ID_2],
    );
    expect(jobs.rows[0].count).toBe(0);
  });

  it("runs the worker runtime end-to-end with restricted queue and ingestor roles", async () => {
    await admin!.query(
      `insert into public.monitors (
         id, organization_id, name, url, method, expected_status_codes,
         interval_seconds, timeout_seconds, is_active
       )
       select $1, organization_id, 'Worker runtime fixture',
              $2, 'GET', array[200], 300, 5, true
       from public.monitors
       where id = $3`,
      [TEST_MONITOR_ID_3, `https://${TEST_HOST}/worker-runtime`, TEST_MONITOR_ID],
    );
    await admin!.query(
      `insert into public.monitor_execution_allowlist (
         monitor_id, organization_id, url, reason
       )
       select id, organization_id, url, 'phase4b worker runtime test'
       from public.monitors
       where id = $1`,
      [TEST_MONITOR_ID_3],
    );
    await admin!.query(
      `insert into public.monitor_schedules (
         organization_id, monitor_id, region, next_run_at
       )
       select organization_id, id, $2, now() - interval '1 minute'
       from public.monitors
       where id = $1`,
      [TEST_MONITOR_ID_3, TEST_REGION],
    );
    await admin!.query(
      `update public.monitor_execution_settings
       set mode = 'fixtures',
           execution_enabled = true,
           reason = 'phase4b worker runtime test',
           egress_verified_at = null,
           egress_verified_by = null
       where singleton`,
    );

    const schedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(schedule.scheduled).toBe(1);

    const queueClient = new QueueClient({
      connectionString: roleUrl("onedash_test_queue"),
      ssl: false,
      max: 2,
    });
    const ingestorClient = new IngestorClient({
      connectionString: roleUrl("onedash_test_ingestor"),
      ssl: false,
      max: 2,
    });

    try {
      const runtime = new WorkerRuntime({
        config: {
          executionMode: "fixtures",
          queueDatabaseUrl: roleUrl("onedash_test_queue"),
          ingestorDatabaseUrl: roleUrl("onedash_test_ingestor"),
          dbSsl: false,
          region: TEST_REGION,
          workerId: "phase4b-runtime-worker",
          concurrency: 2,
          leaseSeconds: 60,
          pollIntervalMs: 50,
          heartbeatIntervalMs: 1000,
          reapIntervalMs: 1000,
          shutdownGraceMs: 2000,
          fixtureHosts: [TEST_HOST],
          healthHost: "127.0.0.1",
          healthPort: 0,
          metricsToken: null,
          logLevel: "error",
        },
        queue: queueClient,
        ingestor: ingestorClient,
        checker: createFixtureChecker(),
        logger: createSilentLogger(),
      });

      await runtime.runOnce();
      await runtime.waitForIdle();

      expect(runtime.getMetrics().claimedTotal).toBeGreaterThanOrEqual(1);
      expect(runtime.getMetrics().completedTotal).toBeGreaterThanOrEqual(1);

      const job = await admin!.query(
        "select * from public.check_jobs where monitor_id = $1",
        [TEST_MONITOR_ID_3],
      );
      expect(job.rowCount).toBe(1);
      expect(job.rows[0]).toMatchObject({
        status: "completed",
        attempts: 1,
        last_error_class: null,
      });
      expect(job.rows[0].result_id).not.toBeNull();

      const result = await admin!.query(
        "select * from public.check_results where monitor_id = $1",
        [TEST_MONITOR_ID_3],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toMatchObject({
        status: "up",
        http_status: 200,
        idempotency_key: job.rows[0].idempotency_key,
      });

      const state = await admin!.query(
        "select * from public.monitor_state where monitor_id = $1",
        [TEST_MONITOR_ID_3],
      );
      expect(state.rowCount).toBe(1);
      expect(state.rows[0].status).toBe("up");
    } finally {
      await Promise.allSettled([queueClient.close(), ingestorClient.close()]);
    }
  });

  it("claims two jobs concurrently without assigning a job to both workers", async () => {
    await cleanupNewMonitors();
    const jobA = await insertPendingJob(TEST_MONITOR_ID_4, "concurrent-claim-a");
    const jobB = await insertPendingJob(TEST_MONITOR_ID_4, "concurrent-claim-b");

    const [first, second] = await Promise.all([
      claimFrom(queue!, "concurrent-worker-a", 1),
      claimFrom(queue2!, "concurrent-worker-b", 1),
    ]);

    const claimedIds = [...first.jobs, ...second.jobs].map((job) => job.job_id);
    expect(claimedIds.sort()).toEqual([jobA, jobB].sort());
    expect(new Set(claimedIds).size).toBe(2);
    expect(first.jobs).toHaveLength(1);
    expect(second.jobs).toHaveLength(1);

    const rows = await admin!.query(
      `select id, status::text, lease_owner
       from public.check_jobs
       where id = any($1::uuid[])`,
      [claimedIds],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.status === "leased")).toBe(true);
    expect(new Set(rows.rows.map((row) => row.lease_owner)).size).toBe(2);
  });

  it("ingests concurrent results exactly once and treats a duplicate ingest as idempotent", async () => {
    await cleanupNewMonitors();
    const jobA = await insertPendingJob(TEST_MONITOR_ID_4, "concurrent-ingest-a");
    const jobB = await insertPendingJob(TEST_MONITOR_ID_4, "concurrent-ingest-b");

    const claim = await claimFrom(queue!, "concurrent-ingest-worker", 2);
    expect(claim.jobs).toHaveLength(2);
    const claimedA = claim.jobs.find((job) => job.job_id === jobA);
    const claimedB = claim.jobs.find((job) => job.job_id === jobB);
    expect(claimedA).toBeDefined();
    expect(claimedB).toBeDefined();

    const [resultA, resultB] = await Promise.all([
      ingestResult(ingestor!, jobA, claimedA!.lease_token, ingestPayload()),
      ingestResult(ingestor2!, jobB, claimedB!.lease_token, ingestPayload()),
    ]);
    expect(resultA).toMatchObject({ ok: true, duplicate: false });
    expect(resultB).toMatchObject({ ok: true, duplicate: false });

    const [duplicateA, duplicateB] = await Promise.all([
      ingestResult(ingestor!, jobA, claimedA!.lease_token, ingestPayload()),
      ingestResult(ingestor2!, jobB, claimedB!.lease_token, ingestPayload()),
    ]);
    expect(duplicateA).toMatchObject({ ok: true, duplicate: true });
    expect(duplicateB).toMatchObject({ ok: true, duplicate: true });

    const results = await admin!.query(
      "select count(*)::int as count from public.check_results where monitor_id = $1",
      [TEST_MONITOR_ID_4],
    );
    expect(results.rows[0].count).toBe(2);

    const jobs = await admin!.query(
      `select status::text, attempts
       from public.check_jobs
       where id = any($1::uuid[])`,
      [[jobA, jobB]],
    );
    expect(jobs.rows).toHaveLength(2);
    expect(
      jobs.rows.every(
        (row) => row.status === "completed" && row.attempts === 1,
      ),
    ).toBe(true);
  });

  it("rejects a stale worker after another worker reclaims the job", async () => {
    await cleanupNewMonitors();
    const id = await insertPendingJob(TEST_MONITOR_ID_4, "stale-worker");

    const first = await claimFrom(queue!, "stale-worker-old", 1);
    expect(first.jobs).toHaveLength(1);
    const oldToken = first.jobs[0].lease_token;

    await admin!.query(
      "update public.check_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [id],
    );
    const reaped = await jsonResult<ReapResult>(
      scheduler!,
      "select public.onedash_reap_expired_leases($1) as result",
      [10],
    );
    expect(reaped.recovered).toBeGreaterThanOrEqual(1);

    await admin!.query(
      "update public.check_jobs set available_at = now() where id = $1",
      [id],
    );
    const second = await claimFrom(queue2!, "stale-worker-new", 1);
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]).toMatchObject({ job_id: id, attempts: 2 });
    const newToken = second.jobs[0].lease_token;
    expect(newToken).not.toBe(oldToken);

    const stale = await ingestResult(
      ingestor!,
      id,
      oldToken,
      ingestPayload(),
    );
    expect(stale).toMatchObject({
      ok: false,
      reason: "lease_mismatch_or_expired",
    });

    const current = await ingestResult(
      ingestor!,
      id,
      newToken,
      ingestPayload(),
    );
    expect(current).toMatchObject({ ok: true, duplicate: false });

    const results = await admin!.query(
      "select count(*)::int as count from public.check_results where monitor_id = $1",
      [TEST_MONITOR_ID_4],
    );
    expect(results.rows[0].count).toBe(1);
  });

  it("retries transient failures until attempts are exhausted", async () => {
    await cleanupNewMonitors();
    const id = await insertPendingJob(TEST_MONITOR_ID_4, "retry-exhaustion", {
      maxAttempts: 5,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await admin!.query(
        "update public.check_jobs set available_at = now() where id = $1",
        [id],
      );
      const claim = await claimFrom(queue!, `retry-worker-${attempt}`, 1);
      expect(claim.jobs).toHaveLength(1);
      expect(claim.jobs[0]).toMatchObject({ job_id: id, attempts: attempt });

      const failed = await jsonResult<FailResult>(
        queue!,
        "select public.onedash_fail_job($1, $2, $3, $4) as result",
        [id, claim.jobs[0].lease_token, "worker_error", true],
      );

      if (attempt < 5) {
        expect(failed).toMatchObject({ ok: true, status: "pending" });
      } else {
        expect(failed).toMatchObject({ ok: true, status: "dead_letter" });
      }
    }

    const row = await admin!.query(
      "select status::text, attempts, max_attempts, last_error_class from public.check_jobs where id = $1",
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "dead_letter",
      attempts: 5,
      max_attempts: 5,
      last_error_class: "worker_error",
    });
  });

  it("dead-letters a blocked target immediately without a retry", async () => {
    await cleanupNewMonitors();
    const id = await insertPendingJob(TEST_MONITOR_ID_4, "blocked-target");

    const claim = await claimFrom(queue!, "blocked-target-worker", 1);
    expect(claim.jobs).toHaveLength(1);
    const failed = await jsonResult<FailResult>(
      queue!,
      "select public.onedash_fail_job($1, $2, $3, $4) as result",
      [id, claim.jobs[0].lease_token, "blocked_target", false],
    );
    expect(failed).toMatchObject({ ok: true, status: "dead_letter" });

    const row = await admin!.query(
      "select status::text, attempts, last_error_class from public.check_jobs where id = $1",
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      last_error_class: "blocked_target",
    });
  });

  it("keeps a second tenant's result and monitor state isolated", async () => {
    await cleanupNewMonitors();
    const id = await insertPendingJob(TEST_MONITOR_ID_5, "tenant-isolation");

    const claim = await claimFrom(queue!, "tenant-worker", 1);
    expect(claim.jobs).toHaveLength(1);
    const ingested = await ingestResult(
      ingestor!,
      id,
      claim.jobs[0].lease_token,
      ingestPayload(),
    );
    expect(ingested).toMatchObject({ ok: true, duplicate: false });

    const globex = await admin!.query(
      "select id from public.organizations where slug = 'globex-status'",
    );
    const result = await admin!.query(
      "select organization_id, status::text from public.check_results where monitor_id = $1",
      [TEST_MONITOR_ID_5],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      organization_id: globex.rows[0].id,
      status: "up",
    });

    const state = await admin!.query(
      "select organization_id, status::text from public.monitor_state where monitor_id = $1",
      [TEST_MONITOR_ID_5],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      organization_id: globex.rows[0].id,
      status: "up",
    });

    const control = await admin!.query(
      `select
         (select count(*)::int from public.check_results where monitor_id = $1) as results,
         (select count(*)::int from public.monitor_state where monitor_id = $1) as states,
         (select count(*)::int from public.check_results where monitor_id = $2) as other_results`,
      [TEST_MONITOR_ID_6, TEST_MONITOR_ID_4],
    );
    expect(control.rows[0]).toEqual({
      results: 0,
      states: 0,
      other_results: 0,
    });
  });

  it("validates acknowledgement ownership for completed and in-flight jobs", async () => {
    await cleanupNewMonitors();
    const id = await insertPendingJob(TEST_MONITOR_ID_4, "acknowledgement");

    const claim = await claimFrom(queue!, "ack-worker", 1);
    expect(claim.jobs).toHaveLength(1);
    const token = claim.jobs[0].lease_token;

    const beforeIngest = await jsonResult<AckResult>(
      ingestor!,
      "select public.onedash_acknowledge_job($1, $2) as result",
      [id, token],
    );
    expect(beforeIngest).toMatchObject({
      ok: false,
      reason: "result_not_found",
    });

    const ingested = await ingestResult(
      ingestor!,
      id,
      token,
      ingestPayload(),
    );
    expect(ingested).toMatchObject({ ok: true, duplicate: false });

    const acknowledged = await jsonResult<AckResult>(
      ingestor!,
      "select public.onedash_acknowledge_job($1, $2) as result",
      [id, token],
    );
    expect(acknowledged).toMatchObject({
      ok: true,
      duplicate: true,
      job_status: "completed",
    });

    const wrongToken = await jsonResult<AckResult>(
      ingestor!,
      "select public.onedash_acknowledge_job($1, $2) as result",
      [id, "00000000-0000-4000-8000-000000000099"],
    );
    expect(wrongToken).toMatchObject({ ok: false, reason: "lease_mismatch" });
  });

  it("requires a live lease for release and failure", async () => {
    await cleanupNewMonitors();
    const id = await insertPendingJob(TEST_MONITOR_ID_4, "expired-release");

    const claim = await claimFrom(queue!, "expired-release-worker", 1);
    expect(claim.jobs).toHaveLength(1);
    const token = claim.jobs[0].lease_token;

    await admin!.query(
      "update public.check_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [id],
    );

    const failed = await jsonResult<FailResult>(
      queue!,
      "select public.onedash_fail_job($1, $2, $3, $4) as result",
      [id, token, "worker_error", true],
    );
    expect(failed).toMatchObject({
      ok: false,
      reason: "lease_mismatch_or_expired",
    });

    const released = await jsonResult<ReleaseResult>(
      queue!,
      "select public.onedash_release_job($1, $2) as result",
      [id, token],
    );
    expect(released).toMatchObject({
      ok: false,
      reason: "lease_mismatch_or_expired",
    });

    const stillLeased = await admin!.query(
      "select status::text, lease_token from public.check_jobs where id = $1",
      [id],
    );
    expect(stillLeased.rows[0]).toMatchObject({
      status: "leased",
      lease_token: token,
    });

    const reaped = await jsonResult<ReapResult>(
      scheduler!,
      "select public.onedash_reap_expired_leases($1) as result",
      [10],
    );
    expect(reaped.recovered).toBeGreaterThanOrEqual(1);

    const recovered = await admin!.query(
      "select status::text, lease_token, lease_expires_at from public.check_jobs where id = $1",
      [id],
    );
    expect(recovered.rows[0]).toMatchObject({
      status: "pending",
      lease_token: null,
      lease_expires_at: null,
    });
  });

  it("validates ingested status codes and the safe error-message vocabulary", async () => {
    await cleanupNewMonitors();
    const id = await insertPendingJob(TEST_MONITOR_ID_4, "status-validation");

    const claim = await claimFrom(queue!, "status-worker", 1);
    expect(claim.jobs).toHaveLength(1);
    const token = claim.jobs[0].lease_token;

    await expectPgError(
      ingestor!.query(
        "select public.onedash_ingest_check_result($1, $2, $3::jsonb)",
        [id, token, JSON.stringify(ingestPayload({ http_status: 500 }))],
      ),
      "22023",
    );

    await expectPgError(
      ingestor!.query(
        "select public.onedash_ingest_check_result($1, $2, $3::jsonb)",
        [
          id,
          token,
          JSON.stringify(
            ingestPayload({
              status: "down",
              http_status: 200,
              error_class: "http_status_mismatch",
              error_message: SAFE_MESSAGES.http_status_mismatch,
            }),
          ),
        ],
      ),
      "22023",
    );

    await expectPgError(
      ingestor!.query(
        "select public.onedash_ingest_check_result($1, $2, $3::jsonb)",
        [
          id,
          token,
          JSON.stringify(
            ingestPayload({
              status: "down",
              http_status: 500,
              error_class: "timeout",
              error_message: "timeout at https://customer.example/private",
            }),
          ),
        ],
      ),
      "22023",
    );

    const valid = await ingestResult(
      ingestor!,
      id,
      token,
      ingestPayload({
        status: "down",
        http_status: 500,
        error_class: "http_status_mismatch",
        error_message: SAFE_MESSAGES.http_status_mismatch,
      }),
    );
    expect(valid).toMatchObject({ ok: true, monitor_status: "down" });

    const result = await admin!.query(
      "select status::text, http_status, error_class, error_message from public.check_results where monitor_id = $1",
      [TEST_MONITOR_ID_4],
    );
    expect(result.rows[0]).toMatchObject({
      status: "down",
      http_status: 500,
      error_class: "http_status_mismatch",
      error_message: SAFE_MESSAGES.http_status_mismatch,
    });
  });

  it("refuses a real due schedule and pending job when the execution gate is disabled or customer", async () => {
    await cleanupNewMonitors();
    await admin!.query(
      `insert into public.monitor_schedules (
         organization_id, monitor_id, region, next_run_at
       )
       select organization_id, id, $2, now() - interval '1 minute'
       from public.monitors
       where id = $1`,
      [TEST_MONITOR_ID_4, TEST_REGION_2],
    );
    const id = await insertPendingJob(TEST_MONITOR_ID_4, "customer-gate");

    await admin!.query(
      `update public.monitor_execution_settings
       set mode = 'disabled',
           execution_enabled = false,
           reason = 'customer gate test disabled',
           egress_verified_at = null,
           egress_verified_by = null
       where singleton`,
    );

    const disabledSchedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(disabledSchedule).toMatchObject({
      scheduled: 0,
      execution_mode: "disabled",
    });
    // Phase 4C.0: leaving enabled fixtures mode dead-letters every pending and
    // leased job, so the job that existed before the gate was disabled is gone.
    const revokedWhileDisabled = await admin!.query(
      "select count(*)::int as count from public.check_jobs where id = $1 and status = 'dead_letter'",
      [id],
    );
    expect(revokedWhileDisabled.rows[0].count).toBe(1);

    const disabledClaim = await claimFrom(queue!, "customer-gate-disabled", 5);
    expect(disabledClaim.jobs).toHaveLength(0);

    // A direct operator insert while the gate is disabled is still refused by
    // the claim function; it remains pending rather than being executed.
    const disabledPendingId = await insertPendingJob(
      TEST_MONITOR_ID_4,
      "customer-gate-disabled-pending",
    );
    const pendingWhileDisabled = await admin!.query(
      "select count(*)::int as count from public.check_jobs where id = $1 and status = 'pending'",
      [disabledPendingId],
    );
    expect(pendingWhileDisabled.rows[0].count).toBe(1);

    await admin!.query(
      `update public.monitor_execution_settings
       set mode = 'customer',
           execution_enabled = true,
           reason = 'customer gate test customer',
           egress_verified_at = now(),
           egress_verified_by = 'phase4b integration test'
       where singleton`,
    );

    const customerSchedule = await jsonResult<ScheduleResult>(
      scheduler!,
      "select public.onedash_schedule_due_jobs($1, $2) as result",
      [10, 0],
    );
    expect(customerSchedule).toMatchObject({
      scheduled: 0,
      execution_mode: "customer",
    });
    const customerClaim = await claimFrom(queue!, "customer-gate-customer", 5);
    expect(customerClaim.jobs).toHaveLength(0);

    const pendingWhileCustomer = await admin!.query(
      "select count(*)::int as count from public.check_jobs where id = $1 and status = 'pending'",
      [disabledPendingId],
    );
    expect(pendingWhileCustomer.rows[0].count).toBe(1);

    await admin!.query(
      `update public.monitor_execution_settings
       set mode = 'fixtures',
           execution_enabled = true,
           reason = 'phase4b integration test',
           egress_verified_at = null,
           egress_verified_by = null
       where singleton`,
    );
  });

  it("records strict heartbeats and cleans up stale heartbeat rows", async () => {
    const instanceId = "phase4b-cleanup-heartbeat";
    await scheduler!.query(
      "select public.onedash_record_heartbeat($1, $2, $3, $4::jsonb)",
      [
        "scheduler",
        instanceId,
        "global",
        JSON.stringify({
          batch_size: 10,
          jitter_seconds: 0,
          last_scheduled: 0,
          last_skipped: 0,
          execution_mode: "fixtures",
        }),
      ],
    );

    await expectPgError(
      queue!.query(
        "select public.onedash_record_heartbeat($1, $2, $3, $4::jsonb)",
        [
          "worker",
          "phase4b-nested-heartbeat",
          TEST_REGION,
          JSON.stringify({
            concurrency: 2,
            in_flight: 0,
            claimed_total: 0,
            completed_total: 0,
            failed_total: 0,
            retried_total: 0,
            last_error_class: null,
            details: { url: "https://customer.example/private" },
          }),
        ],
      ),
      "22023",
    );

    await admin!.query(
      "update public.service_heartbeats set last_seen_at = now() - interval '2 days' where component = 'scheduler' and instance_id = $1",
      [instanceId],
    );

    const schedulerClient = new SchedulerClient({
      connectionString: roleUrl("onedash_test_scheduler"),
      ssl: false,
      max: 1,
    });
    try {
      const deleted = await schedulerClient.cleanupStaleHeartbeats(86400);
      expect(deleted).toBeGreaterThanOrEqual(1);
    } finally {
      await schedulerClient.close();
    }

    const remaining = await admin!.query(
      "select count(*)::int as count from public.service_heartbeats where instance_id = $1",
      [instanceId],
    );
    expect(remaining.rows[0].count).toBe(0);
  });
});
