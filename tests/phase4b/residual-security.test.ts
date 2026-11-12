import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const ADMIN_URL =
  process.env.ONEDASH_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const TEST_PASSWORD = "phase4c_test_password";
const TEST_ROLES = [
  "onedash_test_4c_scheduler",
  "onedash_test_4c_queue",
  "onedash_test_4c_ingestor",
] as const;

const MONITOR_SCHEDULES = "4c100000-0000-4000-8000-000000000001";
const MONITOR_JOBS = "4c100000-0000-4000-8000-000000000002";
const MONITOR_MULTI = "4c100000-0000-4000-8000-000000000003";
const MONITOR_CROSS_A = "4c100000-0000-4000-8000-000000000004";
const MONITOR_CROSS_B = "4c100000-0000-4000-8000-000000000005";
const MONITOR_INGEST = "4c100000-0000-4000-8000-000000000006";
const MONITOR_LOCK = "4c100000-0000-4000-8000-000000000007";
const MONITOR_NAMESPACE = "4c100000-0000-4000-8000-000000000008";
const ALL_MONITORS = [
  MONITOR_SCHEDULES,
  MONITOR_JOBS,
  MONITOR_MULTI,
  MONITOR_CROSS_A,
  MONITOR_CROSS_B,
  MONITOR_INGEST,
  MONITOR_LOCK,
  MONITOR_NAMESPACE,
] as const;
const TEST_REGION = "test-1";
const TEST_HOST = "phase4c-residual.test";

const REGIONS = [
  "us-east",
  "us-west",
  "eu-west",
  "ap-south",
  "test-1",
  "test-2",
] as const;

type JobInsertResult = {
  id: string;
};

type IngestResult = {
  ok: boolean;
  duplicate: boolean;
  job_status: string | null;
  result_id: string | null;
  monitor_status: string | null;
  reason: string | null;
  retryable: boolean | null;
};

type ExecutionSettings = {
  execution_enabled: boolean;
  mode: string;
  reason: string;
  egress_verified_at: Date | null;
  egress_verified_by: string | null;
};

function roleUrl(role: string): string {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = TEST_PASSWORD;
  return url.toString();
}

async function connect(connectionString: string, name: string): Promise<Client> {
  const client = new Client({
    connectionString,
    application_name: name,
  });
  await client.connect();
  return client;
}

async function jsonResult<T>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const result = await client.query(sql, params);
  return result.rows[0].result as T;
}

function ingestPayload(): Record<string, unknown> {
  return {
    status: "up",
    http_status: 200,
    response_time_ms: 10,
    dns_ms: 1,
    connect_ms: 1,
    tls_ms: 1,
    ttfb_ms: 1,
    total_ms: 10,
    error_class: null,
    error_message: null,
    redirect_count: 0,
    response_bytes: 100,
    checked_at: new Date().toISOString(),
  };
}

async function ingest(
  client: Client,
  jobId: string,
  leaseToken: string,
  payload = ingestPayload(),
): Promise<IngestResult> {
  return jsonResult<IngestResult>(
    client,
    "select public.onedash_ingest_check_result($1, $2, $3::jsonb) as result",
    [jobId, leaseToken, JSON.stringify(payload)],
  );
}

async function waitForIngestorLockWait(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await admin!.query(
      `select 1
       from pg_stat_activity
       where application_name = 'phase4c-residual-ingestor-a'
         and state = 'active'
         and wait_event_type = 'Lock'`,
    );
    if ((result.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("ingestor did not wait on the job lock");
}

let admin: Client | null = null;
let ingestorA: Client | null = null;
let ingestorB: Client | null = null;
let organizationId = "";
let originalSettings: ExecutionSettings | null = null;
let ingestionJobId = "";
let ingestionLeaseToken = "";

beforeAll(async () => {
  admin = await connect(ADMIN_URL, "phase4c-residual-admin");

  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where usename = any($1::text[]) and pid <> pg_backend_pid()",
    [TEST_ROLES],
  );
  for (const role of TEST_ROLES) {
    await admin.query(`drop role if exists ${role}`);
  }
  await admin.query(
    `create role onedash_test_4c_scheduler login password '${TEST_PASSWORD}' in role onedash_scheduler`,
  );
  await admin.query(
    `create role onedash_test_4c_queue login password '${TEST_PASSWORD}' in role onedash_queue`,
  );
  await admin.query(
    `create role onedash_test_4c_ingestor login password '${TEST_PASSWORD}' in role onedash_ingestor`,
  );

  await admin.query("delete from public.monitors where id = any($1::uuid[])", [
    ALL_MONITORS,
  ]);

  const org = await admin.query(
    "select id from public.organizations where slug = 'acme-monitoring'",
  );
  organizationId = org.rows[0].id as string;

  await admin.query(
    `insert into public.monitors (
       id, organization_id, name, url, method, expected_status_codes,
       interval_seconds, timeout_seconds, is_active
     )
     select
       v.id,
       $1,
       v.name,
       v.url,
       'GET',
       array[200],
       300,
       5,
       true
     from (
       values
         ($2::uuid, 'Phase 4C schedule cap', $10),
         ($3::uuid, 'Phase 4C job cap', $11),
         ($4::uuid, 'Phase 4C multi-row', $12),
         ($5::uuid, 'Phase 4C cross a', $13),
         ($6::uuid, 'Phase 4C cross b', $14),
         ($7::uuid, 'Phase 4C ingestion', $15),
         ($8::uuid, 'Phase 4C lock', $16),
         ($9::uuid, 'Phase 4C namespace', $17)
     ) as v(id, name, url)`,
    [
      organizationId,
      MONITOR_SCHEDULES,
      MONITOR_JOBS,
      MONITOR_MULTI,
      MONITOR_CROSS_A,
      MONITOR_CROSS_B,
      MONITOR_INGEST,
      MONITOR_LOCK,
      MONITOR_NAMESPACE,
      `https://${TEST_HOST}/schedules`,
      `https://${TEST_HOST}/jobs`,
      `https://${TEST_HOST}/multi`,
      `https://${TEST_HOST}/cross-a`,
      `https://${TEST_HOST}/cross-b`,
      `https://${TEST_HOST}/ingest`,
      `https://${TEST_HOST}/lock`,
      `https://${TEST_HOST}/namespace`,
    ],
  );

  await admin.query(
    `insert into public.monitor_execution_allowlist (
       monitor_id, organization_id, url, reason
     )
     select id, organization_id, url, 'phase4c residual integration test'
     from public.monitors
     where id = any($1::uuid[])`,
    [ALL_MONITORS],
  );

  const settings = await admin.query(
    "select * from public.monitor_execution_settings where singleton",
  );
  originalSettings = settings.rows[0] ?? null;
  await admin.query(
    `update public.monitor_execution_settings
     set mode = 'fixtures',
         execution_enabled = true,
         reason = 'phase4c residual integration test',
         egress_verified_at = null,
         egress_verified_by = null
     where singleton`,
  );

  const inserted = await admin.query(
    `insert into public.check_jobs (
       organization_id, monitor_id, region, scheduled_for, available_at,
       idempotency_key, status, lease_owner, lease_token, lease_expires_at
     )
     values ($1, $2, $3, now(), now(), '4c-integration-ingest', 'leased',
             'integration-worker', gen_random_uuid(), now() + interval '5 minutes')
     returning id, lease_token`,
    [organizationId, MONITOR_INGEST, TEST_REGION],
  );
  ingestionJobId = inserted.rows[0].id as string;
  ingestionLeaseToken = inserted.rows[0].lease_token as string;

  ingestorA = await connect(
    roleUrl("onedash_test_4c_ingestor"),
    "phase4c-residual-ingestor-a",
  );
  ingestorB = await connect(
    roleUrl("onedash_test_4c_ingestor"),
    "phase4c-residual-ingestor-b",
  );
});

afterAll(async () => {
  await Promise.allSettled([ingestorA?.end(), ingestorB?.end(), admin?.end()]);

  let cleanup: Client | null = null;
  try {
    cleanup = await connect(ADMIN_URL, "phase4c-residual-cleanup");
    if (originalSettings) {
      await cleanup.query(
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
    await cleanup.query(
      "delete from public.monitors where id = any($1::uuid[])",
      [ALL_MONITORS],
    );
    await cleanup.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = any($1::text[]) and pid <> pg_backend_pid()",
      [TEST_ROLES],
    );
    for (const role of TEST_ROLES) {
      await cleanup.query(`drop role if exists ${role}`);
    }
  } catch {
    // Best-effort cleanup; a failed test should still report its assertion.
  } finally {
    await cleanup?.end();
  }
});

describe("Phase 4C residual concurrency and ingestion hardening", () => {
  it("serializes six independent schedule inserts to the five-schedule cap", async () => {
    const clients = await Promise.all(
      REGIONS.map((_, index) =>
        connect(ADMIN_URL, `phase4c-residual-schedule-${index}`),
      ),
    );

    try {
      const results = await Promise.allSettled(
        clients.map(async (client, index) => {
          await client.query("begin");
          try {
            const result = await client.query(
              `insert into public.monitor_schedules (
                 organization_id, monitor_id, region, next_run_at
               )
               values ($1, $2, $3, null)`,
              [organizationId, MONITOR_SCHEDULES, REGIONS[index]],
            );
            await client.query("commit");
            return result;
          } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
          }
        }),
      );

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(5);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: "23514" });

      const count = await admin!.query(
        "select count(*)::int as count from public.monitor_schedules where monitor_id = $1",
        [MONITOR_SCHEDULES],
      );
      expect(count.rows[0].count).toBe(5);
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  });

  it("serializes eleven independent job inserts to the ten-job cap", async () => {
    const clients = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        connect(ADMIN_URL, `phase4c-residual-job-${index}`),
      ),
    );

    try {
      const results = await Promise.allSettled(
        clients.map(async (client, index) => {
          await client.query("begin");
          try {
            const result = await client.query<JobInsertResult>(
              `insert into public.check_jobs (
                 organization_id, monitor_id, region, scheduled_for, available_at,
                 idempotency_key, status
               )
               values ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5, 'pending')
               returning id`,
              [
                organizationId,
                MONITOR_JOBS,
                TEST_REGION,
                new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
                `4c-integration-cap-${index}`,
              ],
            );
            await client.query("commit");
            return result;
          } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
          }
        }),
      );

      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true,
      );

      const inserted = results.reduce(
        (total, result) =>
          total +
          (result.status === "fulfilled" ? (result.value.rowCount ?? 0) : 0),
        0,
      );
      expect(inserted).toBe(10);

      const count = await admin!.query(
        "select count(*)::int as count from public.check_jobs where monitor_id = $1 and status = 'pending'",
        [MONITOR_JOBS],
      );
      expect(count.rows[0].count).toBe(10);
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
    }
  });

  it("caps a single multi-row insert at ten jobs", async () => {
    const result = await admin!.query<{ count: number }>(
      `with inserted as (
         insert into public.check_jobs (
           organization_id, monitor_id, region, scheduled_for, available_at,
           idempotency_key, status
         )
         select
           $1,
           $2,
           $3,
           '2026-01-02T00:00:00Z'::timestamptz + (n || ' seconds')::interval,
           '2026-01-02T00:00:00Z'::timestamptz + (n || ' seconds')::interval,
           '4c-integration-multi-' || n,
           'pending'
         from generate_series(1, 15) as n
         returning 1
       )
       select count(*)::int as count from inserted`,
      [organizationId, MONITOR_MULTI, TEST_REGION],
    );
    expect(result.rows[0].count).toBe(10);
  });

  it("uses separate per-monitor namespaces for job and schedule caps", async () => {
    const lockHolder = await connect(ADMIN_URL, "phase4c-residual-lock-holder");
    const scheduleLockHolder = await connect(
      ADMIN_URL,
      "phase4c-residual-schedule-lock-holder",
    );
    const otherMonitor = await connect(
      ADMIN_URL,
      "phase4c-residual-other-monitor",
    );
    const blockedMonitor = await connect(
      ADMIN_URL,
      "phase4c-residual-blocked-monitor",
    );
    const sameMonitorJob = await connect(
      ADMIN_URL,
      "phase4c-residual-same-monitor-job",
    );

    try {
      await lockHolder.query("begin");
      await lockHolder.query(
        "select pg_advisory_xact_lock(hashtextextended('onedash-job-cap:' || $1, 0))",
        [MONITOR_LOCK],
      );

      await otherMonitor.query("set statement_timeout = '2s'");
      const other = await otherMonitor.query(
        `insert into public.check_jobs (
           organization_id, monitor_id, region, scheduled_for, available_at,
           idempotency_key, status
         )
         values ($1, $2, $3, now(), now(), '4c-integration-other-monitor', 'pending')
         returning id`,
        [organizationId, MONITOR_CROSS_B, TEST_REGION],
      );
      expect(other.rowCount).toBe(1);

      await blockedMonitor.query("set statement_timeout = '500ms'");
      await expect(
        blockedMonitor.query(
          `insert into public.check_jobs (
             organization_id, monitor_id, region, scheduled_for, available_at,
             idempotency_key, status
           )
           values ($1, $2, $3, now(), now(), '4c-integration-blocked-monitor', 'pending')
           returning id`,
          [organizationId, MONITOR_LOCK, TEST_REGION],
        ),
      ).rejects.toMatchObject({ code: "57014" });

      await scheduleLockHolder.query("begin");
      await scheduleLockHolder.query(
        "select pg_advisory_xact_lock(hashtextextended('onedash-schedule-cap:' || $1, 0))",
        [MONITOR_NAMESPACE],
      );

      await sameMonitorJob.query("set statement_timeout = '2s'");
      const job = await sameMonitorJob.query(
        `insert into public.check_jobs (
           organization_id, monitor_id, region, scheduled_for, available_at,
           idempotency_key, status
         )
         values ($1, $2, $3, now(), now(), '4c-integration-namespace-job', 'pending')
         returning id`,
        [organizationId, MONITOR_NAMESPACE, TEST_REGION],
      );
      expect(job.rowCount).toBe(1);
    } finally {
      await Promise.allSettled([
        lockHolder.query("rollback"),
        scheduleLockHolder.query("rollback"),
        lockHolder.end(),
        scheduleLockHolder.end(),
        otherMonitor.end(),
        blockedMonitor.end(),
        sameMonitorJob.end(),
      ]);
    }
  });

  it("accepts exactly one of two concurrent identical ingestions", async () => {
    const results = await Promise.all([
      ingest(ingestorA!, ingestionJobId, ingestionLeaseToken),
      ingest(ingestorB!, ingestionJobId, ingestionLeaseToken),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.duplicate === false)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.duplicate === true)).toHaveLength(1);

    const resultCount = await admin!.query(
      "select count(*)::int as count from public.check_results where monitor_id = $1",
      [MONITOR_INGEST],
    );
    expect(resultCount.rows[0].count).toBe(1);

    const stateCount = await admin!.query(
      "select count(*)::int as count from public.monitor_state where monitor_id = $1",
      [MONITOR_INGEST],
    );
    expect(stateCount.rows[0].count).toBe(1);
  });

  it("rejects an ingestion after the allowlist is revoked without writing a result", async () => {
    const job = await admin!.query(
      `insert into public.check_jobs (
         organization_id, monitor_id, region, scheduled_for, available_at,
         idempotency_key, status, lease_owner, lease_token, lease_expires_at
       )
       values ($1, $2, $3, now(), now(), '4c-integration-revoked', 'leased',
               'integration-worker', gen_random_uuid(), now() + interval '5 minutes')
       returning id, lease_token`,
      [organizationId, MONITOR_INGEST, TEST_REGION],
    );

    await admin!.query(
      "delete from public.monitor_execution_allowlist where monitor_id = $1",
      [MONITOR_INGEST],
    );

    const result = await ingest(
      ingestorA!,
      job.rows[0].id as string,
      job.rows[0].lease_token as string,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "monitor_not_authorized",
      retryable: false,
    });

    const resultCount = await admin!.query(
      "select count(*)::int as count from public.check_results where monitor_id = $1",
      [MONITOR_INGEST],
    );
    expect(resultCount.rows[0].count).toBe(1);

    const state = await admin!.query(
      "select status::text, last_checked_at from public.monitor_state where monitor_id = $1",
      [MONITOR_INGEST],
    );
    expect(state.rowCount).toBe(1);
    expect(state.rows[0].status).toBe("up");

    // Restore authorization so the next test reaches the lease validation
    // rather than failing earlier on the allowlist.
    await admin!.query(
      `insert into public.monitor_execution_allowlist (
         monitor_id, organization_id, url, reason
       )
       select id, organization_id, url, 'phase4c residual integration test'
       from public.monitors
       where id = $1`,
      [MONITOR_INGEST],
    );
  });

  it("rejects an ingestion after the lease expires without writing a result", async () => {
    const job = await admin!.query(
      `insert into public.check_jobs (
         organization_id, monitor_id, region, scheduled_for, available_at,
         idempotency_key, status, lease_owner, lease_token, lease_expires_at
       )
       values ($1, $2, $3, now() + interval '1 second',
               now() + interval '1 second', '4c-integration-expired', 'leased',
               'integration-worker', gen_random_uuid(), now() + interval '5 minutes')
       returning id, lease_token`,
      [organizationId, MONITOR_INGEST, TEST_REGION],
    );

    await admin!.query(
      "update public.check_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [job.rows[0].id],
    );

    const result = await ingest(
      ingestorA!,
      job.rows[0].id as string,
      job.rows[0].lease_token as string,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "lease_mismatch_or_expired",
      retryable: false,
    });

    const resultCount = await admin!.query(
      "select count(*)::int as count from public.check_results where monitor_id = $1",
      [MONITOR_INGEST],
    );
    expect(resultCount.rows[0].count).toBe(1);
  });

  it("rejects an ingestion whose lease expires while waiting for the job lock", async () => {
    const job = await admin!.query(
      `insert into public.check_jobs (
         organization_id, monitor_id, region, scheduled_for, available_at,
         idempotency_key, status, lease_owner, lease_token, lease_expires_at
       )
       values ($1, $2, $3, now() + interval '2 seconds',
               now() + interval '2 seconds', '4c-integration-lock-wait-expiry',
               'leased', 'integration-worker', gen_random_uuid(),
               now() + interval '30 seconds')
       returning id, lease_token`,
      [organizationId, MONITOR_INGEST, TEST_REGION],
    );
    const lockHolder = await connect(
      ADMIN_URL,
      "phase4c-residual-ingest-lock",
    );
    let ingestPromise: Promise<IngestResult> | null = null;

    try {
      await lockHolder.query("begin");
      await lockHolder.query(
        "select 1 from public.check_jobs where id = $1 for update",
        [job.rows[0].id],
      );

      ingestPromise = ingest(
        ingestorA!,
        job.rows[0].id as string,
        job.rows[0].lease_token as string,
      );
      await waitForIngestorLockWait();

      // Expire the lease while the ingestor is blocked. The lock holder owns the
      // row lock, so this update is safe and becomes visible when it commits.
      await lockHolder.query(
        `update public.check_jobs
         set lease_expires_at = now() - interval '1 second'
         where id = $1`,
        [job.rows[0].id],
      );
      await lockHolder.query("commit");

      const result = await ingestPromise;
      expect(result).toMatchObject({
        ok: false,
        reason: "lease_mismatch_or_expired",
        retryable: false,
      });

      const resultCount = await admin!.query(
        "select count(*)::int as count from public.check_results where monitor_id = $1",
        [MONITOR_INGEST],
      );
      expect(resultCount.rows[0].count).toBe(1);
    } finally {
      await Promise.allSettled([
        ingestPromise?.catch(() => undefined),
        lockHolder.query("rollback"),
        lockHolder.end(),
      ]);
    }
  });

  it("returns job_not_found for an unknown job", async () => {
    const result = await ingest(
      ingestorA!,
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "job_not_found",
      retryable: false,
    });
  });
});
