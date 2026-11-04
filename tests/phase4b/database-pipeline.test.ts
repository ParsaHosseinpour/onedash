import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createFixtureChecker } from "../../worker/checker/adapter";
import { IngestorClient } from "../../worker/ingestor/ingestor-client";
import { createSilentLogger } from "../../worker/logging";
import { QueueClient } from "../../worker/queue/queue-client";
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
const TEST_REGION = "test-1";
const TEST_HOST = "phase4b-fixture.test";
const TEST_URL = `https://${TEST_HOST}/health`;
const TEST_WORKER_ID = "phase4b-worker";

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

let admin: Client | null = null;
let scheduler: Client | null = null;
let scheduler2: Client | null = null;
let queue: Client | null = null;
let ingestor: Client | null = null;

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
  ingestor = new Client({ connectionString: roleUrl("onedash_test_ingestor") });
  await Promise.all([
    scheduler.connect(),
    scheduler2.connect(),
    queue.connect(),
    ingestor.connect(),
  ]);

  await admin.query("delete from public.monitors where id = any($1::uuid[])", [
    [TEST_MONITOR_ID, TEST_MONITOR_ID_2, TEST_MONITOR_ID_3],
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
       monitor_id, organization_id, reason
     )
     select id, organization_id, 'phase4b integration test'
     from public.monitors
     where id = $1`,
    [TEST_MONITOR_ID],
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
    ingestor?.end(),
  ]);

  if (admin) {
    try {
      if (originalSettings) {
        await admin.query(
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
      }

      for (const row of savedSchedules) {
        await admin.query(
          "update public.monitor_schedules set next_run_at = $2 where id = $1",
          [row.id, row.next_run_at],
        );
      }

      await admin.query(
        "delete from public.monitors where id = any($1::uuid[])",
        [[TEST_MONITOR_ID, TEST_MONITOR_ID_2, TEST_MONITOR_ID_3]],
      );

      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where usename = any($1::text[]) and pid <> pg_backend_pid()",
        [TEST_ROLES],
      );
      for (const role of TEST_ROLES) {
        await admin.query(`drop role if exists ${role}`);
      }
    } finally {
      await admin.end();
    }
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
    expect(wrongToken.duplicate).toBe(true);
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
    expect(rejected).toMatchObject({ ok: false, reason: "lease_mismatch" });
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
    expect(rejected).toMatchObject({ ok: false, reason: "lease_mismatch" });
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
         monitor_id, organization_id, reason
       )
       select id, organization_id, 'phase4b worker runtime test'
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
});
