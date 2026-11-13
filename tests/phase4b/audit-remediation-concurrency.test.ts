import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const ADMIN_URL =
  process.env.ONEDASH_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const TEST_PASSWORD = "phase4c01_test_password";
const TEST_ROLES = [
  "onedash_test_4c01_scheduler",
  "onedash_test_4c01_queue",
] as const;

const MONITOR_JOBS_A = "4c110000-0000-4000-8000-000000000001";
const MONITOR_JOBS_B = "4c110000-0000-4000-8000-000000000002";
const MONITOR_SCHEDULES_A = "4c110000-0000-4000-8000-000000000003";
const MONITOR_SCHEDULES_B = "4c110000-0000-4000-8000-000000000004";
const MONITOR_CLAIM = "4c110000-0000-4000-8000-000000000005";
const MONITOR_SCHEDULE = "4c110000-0000-4000-8000-000000000006";
const MONITOR_MIXED_A = "4c110000-0000-4000-8000-000000000007";
const MONITOR_MIXED_B = "4c110000-0000-4000-8000-000000000008";
const ALL_MONITORS = [
  MONITOR_JOBS_A,
  MONITOR_JOBS_B,
  MONITOR_SCHEDULES_A,
  MONITOR_SCHEDULES_B,
  MONITOR_CLAIM,
  MONITOR_SCHEDULE,
  MONITOR_MIXED_A,
  MONITOR_MIXED_B,
] as const;

const TEST_REGION = "test-1";
const TEST_REGION_2 = "test-2";
const TEST_HOST = "phase4c01-race.test";

type ExecutionSettings = {
  execution_enabled: boolean;
  mode: string;
  reason: string;
  egress_verified_at: Date | null;
  egress_verified_by: string | null;
};

type ClaimedJob = {
  job_id: string;
  lease_token: string;
};

type ClaimResult = {
  execution_mode: string;
  jobs: ClaimedJob[];
  reason?: string;
};

type ScheduleResult = {
  scheduled: number;
  skipped: number;
  execution_mode: string;
  reason?: string;
};

function roleUrl(role: string): string {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = TEST_PASSWORD;
  return url.toString();
}

async function connect(connectionString: string, name: string): Promise<Client> {
  const client = new Client({ connectionString, application_name: name });
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

async function waitForLockWait(
  applicationName: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await admin!.query(
      `select 1
       from pg_stat_activity
       where application_name = $1
         and state = 'active'
         and wait_event_type = 'Lock'`,
      [applicationName],
    );
    if ((result.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${applicationName} did not wait on a lock`);
}

async function setGate(
  enabled: boolean,
  mode: string,
  reason: string,
): Promise<void> {
  await admin!.query(
    `update public.monitor_execution_settings
     set execution_enabled = $1, mode = $2, reason = $3
     where singleton`,
    [enabled, mode, reason],
  );
}

async function insertPendingJob(
  monitorId: string,
  idempotencyKey: string,
): Promise<string> {
  const result = await admin!.query(
    `insert into public.check_jobs (
       organization_id, monitor_id, region, scheduled_for, available_at,
       idempotency_key, status
     )
     values ($1, $2, $3, now(), now(), $4, 'pending')
     returning id`,
    [organizationId, monitorId, TEST_REGION, idempotencyKey],
  );
  return result.rows[0].id as string;
}

async function queueClaim(client: Client, workerId: string): Promise<ClaimResult> {
  return jsonResult<ClaimResult>(
    client,
    "select public.onedash_claim_jobs($1, $2, $3, $4, $5::text[]) as result",
    [workerId, TEST_REGION, 60, 5, [TEST_HOST]],
  );
}

async function scheduleDue(client: Client): Promise<ScheduleResult> {
  return jsonResult<ScheduleResult>(
    client,
    "select public.onedash_schedule_due_jobs($1, $2) as result",
    [50, 0],
  );
}

function jobInsertSql(): string {
  return `insert into public.check_jobs (
            organization_id, monitor_id, region, scheduled_for, available_at,
            idempotency_key, status
          )
          values ($1, $2, $3, now(), now(), $4, 'pending')
          returning id`;
}

function scheduleInsertSql(): string {
  return `insert into public.monitor_schedules (
            organization_id, monitor_id, region, next_run_at
          )
          values ($1, $2, $3, null)
          returning id`;
}

let admin: Client | null = null;
let scheduler: Client | null = null;
let queue: Client | null = null;
let organizationId = "";
let originalSettings: ExecutionSettings | null = null;
let savedSchedules: Array<{ id: string; next_run_at: Date }> = [];

beforeAll(async () => {
  admin = await connect(ADMIN_URL, "phase4c01-admin");

  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where usename = any($1::text[]) and pid <> pg_backend_pid()",
    [TEST_ROLES],
  );
  for (const role of TEST_ROLES) {
    await admin.query(`drop role if exists ${role}`);
  }
  await admin.query(
    `create role onedash_test_4c01_scheduler login password '${TEST_PASSWORD}' in role onedash_scheduler`,
  );
  await admin.query(
    `create role onedash_test_4c01_queue login password '${TEST_PASSWORD}' in role onedash_queue`,
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
     select v.id, $1, v.name, v.url, 'GET', array[200], 300, 5, true
     from (
       values
         ($2::uuid, 'Phase 4C.0.1 jobs a', $10),
         ($3::uuid, 'Phase 4C.0.1 jobs b', $11),
         ($4::uuid, 'Phase 4C.0.1 schedules a', $12),
         ($5::uuid, 'Phase 4C.0.1 schedules b', $13),
         ($6::uuid, 'Phase 4C.0.1 claim race', $14),
         ($7::uuid, 'Phase 4C.0.1 schedule race', $15),
         ($8::uuid, 'Phase 4C.0.1 mixed a', $16),
         ($9::uuid, 'Phase 4C.0.1 mixed b', $17)
     ) as v(id, name, url)`,
    [
      organizationId,
      MONITOR_JOBS_A,
      MONITOR_JOBS_B,
      MONITOR_SCHEDULES_A,
      MONITOR_SCHEDULES_B,
      MONITOR_CLAIM,
      MONITOR_SCHEDULE,
      MONITOR_MIXED_A,
      MONITOR_MIXED_B,
      `https://${TEST_HOST}/jobs-a`,
      `https://${TEST_HOST}/jobs-b`,
      `https://${TEST_HOST}/schedules-a`,
      `https://${TEST_HOST}/schedules-b`,
      `https://${TEST_HOST}/claim-race`,
      `https://${TEST_HOST}/schedule-race`,
      `https://${TEST_HOST}/mixed-a`,
      `https://${TEST_HOST}/mixed-b`,
    ],
  );

  await admin.query(
    `insert into public.monitor_execution_allowlist (
       monitor_id, organization_id, url, reason
     )
     select id, organization_id, url, 'phase4c01 concurrency test'
     from public.monitors
     where id = any($1::uuid[])`,
    [ALL_MONITORS],
  );

  const settings = await admin.query(
    "select * from public.monitor_execution_settings where singleton",
  );
  originalSettings = settings.rows[0] ?? null;
  await setGate(true, "fixtures", "phase4c01 concurrency test");

  const saved = await admin.query(
    `select id, next_run_at
     from public.monitor_schedules
     where next_run_at is not null
       and monitor_id <> all($1::uuid[])`,
    [ALL_MONITORS],
  );
  savedSchedules = saved.rows;
  await admin.query(
    `update public.monitor_schedules
     set next_run_at = now() + interval '1 hour'
     where next_run_at is not null
       and monitor_id <> all($1::uuid[])`,
    [ALL_MONITORS],
  );

  scheduler = await connect(
    roleUrl("onedash_test_4c01_scheduler"),
    "phase4c01-scheduler",
  );
  queue = await connect(roleUrl("onedash_test_4c01_queue"), "phase4c01-queue");
});

afterAll(async () => {
  await Promise.allSettled([scheduler?.end(), queue?.end()]);

  let cleanup: Client | null = null;
  try {
    cleanup = await connect(ADMIN_URL, "phase4c01-cleanup");
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
    for (const row of savedSchedules) {
      await cleanup.query(
        "update public.monitor_schedules set next_run_at = $2 where id = $1",
        [row.id, row.next_run_at],
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
    if (cleanup) await cleanup.end().catch(() => undefined);
    if (admin) await admin.end().catch(() => undefined);
  }
});

describe("Phase 4C.0.1 global cap lock (B-1)", () => {
  it("commits opposite-order multi-monitor job inserts without a deadlock", async () => {
    const forward = await connect(ADMIN_URL, "phase4c01-jobs-forward");
    const reverse = await connect(ADMIN_URL, "phase4c01-jobs-reverse");
    let reversePromise: Promise<unknown> | null = null;

    try {
      await forward.query("begin");
      await forward.query(jobInsertSql(), [
        organizationId,
        MONITOR_JOBS_A,
        TEST_REGION,
        "4c01-deadlock-jobs-forward-a",
      ]);

      await reverse.query("begin");
      reversePromise = reverse.query(jobInsertSql(), [
        organizationId,
        MONITOR_JOBS_B,
        TEST_REGION,
        "4c01-deadlock-jobs-reverse-b",
      ]);
      await waitForLockWait("phase4c01-jobs-reverse");

      // The forward transaction already owns the global lock, so its second
      // monitor does not wait for the reverse transaction's first row.
      await forward.query(jobInsertSql(), [
        organizationId,
        MONITOR_JOBS_B,
        TEST_REGION,
        "4c01-deadlock-jobs-forward-b",
      ]);
      await forward.query("commit");

      await reversePromise;
      reversePromise = null;
      await reverse.query(jobInsertSql(), [
        organizationId,
        MONITOR_JOBS_A,
        TEST_REGION,
        "4c01-deadlock-jobs-reverse-a",
      ]);
      await reverse.query("commit");

      const counts = await admin!.query(
        `select monitor_id, count(*)::int as count
         from public.check_jobs
         where monitor_id = any($1::uuid[])
         group by monitor_id
         order by monitor_id`,
        [[MONITOR_JOBS_A, MONITOR_JOBS_B]],
      );
      expect(counts.rows).toEqual([
        { monitor_id: MONITOR_JOBS_A, count: 2 },
        { monitor_id: MONITOR_JOBS_B, count: 2 },
      ]);
    } finally {
      await Promise.allSettled([
        reversePromise ?? Promise.resolve(),
        forward.query("rollback"),
        reverse.query("rollback"),
        forward.end(),
        reverse.end(),
      ]);
    }
  });

  it("commits opposite-order multi-monitor schedule inserts without a deadlock", async () => {
    const forward = await connect(ADMIN_URL, "phase4c01-schedules-forward");
    const reverse = await connect(ADMIN_URL, "phase4c01-schedules-reverse");
    let reversePromise: Promise<unknown> | null = null;

    try {
      await forward.query("begin");
      await forward.query(scheduleInsertSql(), [
        organizationId,
        MONITOR_SCHEDULES_A,
        TEST_REGION,
      ]);

      await reverse.query("begin");
      reversePromise = reverse.query(scheduleInsertSql(), [
        organizationId,
        MONITOR_SCHEDULES_B,
        TEST_REGION_2,
      ]);
      await waitForLockWait("phase4c01-schedules-reverse");

      await forward.query(scheduleInsertSql(), [
        organizationId,
        MONITOR_SCHEDULES_B,
        TEST_REGION,
      ]);
      await forward.query("commit");

      await reversePromise;
      reversePromise = null;
      await reverse.query(scheduleInsertSql(), [
        organizationId,
        MONITOR_SCHEDULES_A,
        TEST_REGION_2,
      ]);
      await reverse.query("commit");

      const counts = await admin!.query(
        `select monitor_id, count(*)::int as count
         from public.monitor_schedules
         where monitor_id = any($1::uuid[])
         group by monitor_id
         order by monitor_id`,
        [[MONITOR_SCHEDULES_A, MONITOR_SCHEDULES_B]],
      );
      expect(counts.rows).toEqual([
        { monitor_id: MONITOR_SCHEDULES_A, count: 2 },
        { monitor_id: MONITOR_SCHEDULES_B, count: 2 },
      ]);
    } finally {
      await Promise.allSettled([
        reversePromise ?? Promise.resolve(),
        forward.query("rollback"),
        reverse.query("rollback"),
        forward.end(),
        reverse.end(),
      ]);
    }
  });

  it("shares one lock namespace across schedule and job triggers", async () => {
    const scheduleFirst = await connect(
      ADMIN_URL,
      "phase4c01-mixed-schedule-first",
    );
    const jobFirst = await connect(ADMIN_URL, "phase4c01-mixed-job-first");
    let jobFirstPromise: Promise<unknown> | null = null;

    try {
      await scheduleFirst.query("begin");
      await scheduleFirst.query(scheduleInsertSql(), [
        organizationId,
        MONITOR_MIXED_A,
        TEST_REGION,
      ]);

      await jobFirst.query("begin");
      jobFirstPromise = jobFirst.query(jobInsertSql(), [
        organizationId,
        MONITOR_MIXED_B,
        TEST_REGION,
        "4c01-mixed-job-first-b",
      ]);
      await waitForLockWait("phase4c01-mixed-job-first");

      // The same transaction can re-enter the global lock for the job trigger.
      await scheduleFirst.query(jobInsertSql(), [
        organizationId,
        MONITOR_MIXED_B,
        TEST_REGION,
        "4c01-mixed-schedule-first-b",
      ]);
      await scheduleFirst.query("commit");

      await jobFirstPromise;
      jobFirstPromise = null;
      await jobFirst.query(scheduleInsertSql(), [
        organizationId,
        MONITOR_MIXED_A,
        TEST_REGION_2,
      ]);
      await jobFirst.query("commit");

      const jobCount = await admin!.query(
        "select count(*)::int as count from public.check_jobs where monitor_id = $1",
        [MONITOR_MIXED_B],
      );
      const scheduleCount = await admin!.query(
        "select count(*)::int as count from public.monitor_schedules where monitor_id = $1",
        [MONITOR_MIXED_A],
      );
      expect(jobCount.rows[0].count).toBe(2);
      expect(scheduleCount.rows[0].count).toBe(2);
    } finally {
      await Promise.allSettled([
        jobFirstPromise ?? Promise.resolve(),
        scheduleFirst.query("rollback"),
        jobFirst.query("rollback"),
        scheduleFirst.end(),
        jobFirst.end(),
      ]);
    }
  });
});

describe("Phase 4C.0.1 execution-gate locking (A-1)", () => {
  it("makes a claim wait for a concurrent gate disable and then observe it", async () => {
    const jobId = await insertPendingJob(
      MONITOR_CLAIM,
      "4c01-claim-waits-for-disable",
    );
    const disabler = await connect(ADMIN_URL, "phase4c01-claim-disable-holder");
    const claimant = await connect(
      roleUrl("onedash_test_4c01_queue"),
      "phase4c01-claim-waits",
    );
    let claimPromise: Promise<ClaimResult> | null = null;

    try {
      await disabler.query("begin");
      await disabler.query(
        `update public.monitor_execution_settings
         set execution_enabled = false, mode = 'disabled', reason = 'phase4c01 claim wait'
         where singleton`,
      );

      claimPromise = queueClaim(claimant, "phase4c01-claim-worker");
      await waitForLockWait("phase4c01-claim-waits");

      await disabler.query("commit");
      const result = await claimPromise;
      claimPromise = null;

      expect(result.jobs).toHaveLength(0);
      expect(result.execution_mode).toBe("disabled");
      expect(result.reason).toBe("phase4c01 claim wait");

      const job = await admin!.query(
        "select status::text, lease_token, lease_owner from public.check_jobs where id = $1",
        [jobId],
      );
      expect(job.rows[0]).toMatchObject({
        status: "dead_letter",
        lease_token: null,
        lease_owner: null,
      });
    } finally {
      await Promise.allSettled([
        claimPromise ?? Promise.resolve(),
        disabler.query("rollback"),
        disabler.end(),
        claimant.end(),
        setGate(true, "fixtures", "phase4c01 concurrency test"),
      ]);
    }
  });

  it("makes a schedule call wait for a concurrent gate disable and then observe it", async () => {
    await admin!.query(
      "delete from public.check_jobs where monitor_id = $1",
      [MONITOR_SCHEDULE],
    );
    await admin!.query(
      "delete from public.monitor_schedules where monitor_id = $1",
      [MONITOR_SCHEDULE],
    );
    await admin!.query(
      `insert into public.monitor_schedules (
         organization_id, monitor_id, region, next_run_at
       )
       values ($1, $2, $3, now() - interval '1 minute')`,
      [organizationId, MONITOR_SCHEDULE, TEST_REGION],
    );
    const disabler = await connect(
      ADMIN_URL,
      "phase4c01-schedule-disable-holder",
    );
    const schedulerCaller = await connect(
      roleUrl("onedash_test_4c01_scheduler"),
      "phase4c01-schedule-waits",
    );
    let schedulePromise: Promise<ScheduleResult> | null = null;

    try {
      await disabler.query("begin");
      await disabler.query(
        `update public.monitor_execution_settings
         set execution_enabled = false, mode = 'disabled', reason = 'phase4c01 schedule wait'
         where singleton`,
      );

      schedulePromise = scheduleDue(schedulerCaller);
      await waitForLockWait("phase4c01-schedule-waits");

      await disabler.query("commit");
      const result = await schedulePromise;
      schedulePromise = null;

      expect(result.scheduled).toBe(0);
      expect(result.execution_mode).toBe("disabled");
      expect(result.reason).toBe("phase4c01 schedule wait");

      const jobs = await admin!.query(
        "select count(*)::int as count from public.check_jobs where monitor_id = $1",
        [MONITOR_SCHEDULE],
      );
      expect(jobs.rows[0].count).toBe(0);
    } finally {
      await Promise.allSettled([
        schedulePromise ?? Promise.resolve(),
        disabler.query("rollback"),
        disabler.end(),
        schedulerCaller.end(),
        setGate(true, "fixtures", "phase4c01 concurrency test"),
      ]);
    }
  });

  it("revokes a lease claimed just before a gate disable", async () => {
    const jobId = await insertPendingJob(
      MONITOR_CLAIM,
      "4c01-claim-wins-then-disabled",
    );
    const claimant = await connect(
      roleUrl("onedash_test_4c01_queue"),
      "phase4c01-claim-winner",
    );
    const disabler = await connect(ADMIN_URL, "phase4c01-gate-disable-waits");
    let disablePromise: Promise<unknown> | null = null;

    try {
      await claimant.query("begin");
      const claimed = await queueClaim(claimant, "phase4c01-claim-winner-worker");
      expect(claimed.jobs).toHaveLength(1);
      expect(claimed.jobs[0].job_id).toBe(jobId);

      // The claim transaction still holds FOR SHARE on the gate row, so the
      // disable waits until the claim commits and then dead-letters the lease.
      disablePromise = disabler.query(
        `update public.monitor_execution_settings
         set execution_enabled = false, mode = 'disabled', reason = 'phase4c01 claim winner'
         where singleton`,
      );
      await waitForLockWait("phase4c01-gate-disable-waits");

      await claimant.query("commit");
      await disablePromise;
      disablePromise = null;

      const job = await admin!.query(
        `select status::text, lease_token, lease_owner, completed_at
         from public.check_jobs
         where id = $1`,
        [jobId],
      );
      expect(job.rows[0]).toMatchObject({
        status: "dead_letter",
        lease_token: null,
        lease_owner: null,
        completed_at: null,
      });
    } finally {
      await Promise.allSettled([
        disablePromise ?? Promise.resolve(),
        claimant.query("rollback"),
        claimant.end(),
        disabler.end(),
        setGate(true, "fixtures", "phase4c01 concurrency test"),
      ]);
    }
  });

  it("revokes a scheduled job created just before a gate disable", async () => {
    await admin!.query(
      "delete from public.check_jobs where monitor_id = $1",
      [MONITOR_SCHEDULE],
    );
    await admin!.query(
      "delete from public.monitor_schedules where monitor_id = $1",
      [MONITOR_SCHEDULE],
    );
    await admin!.query(
      `insert into public.monitor_schedules (
         organization_id, monitor_id, region, next_run_at
       )
       values ($1, $2, $3, now() - interval '1 minute')`,
      [organizationId, MONITOR_SCHEDULE, TEST_REGION],
    );
    const schedulerCaller = await connect(
      roleUrl("onedash_test_4c01_scheduler"),
      "phase4c01-schedule-winner",
    );
    const disabler = await connect(
      ADMIN_URL,
      "phase4c01-schedule-disable-waits",
    );
    let disablePromise: Promise<unknown> | null = null;

    try {
      await schedulerCaller.query("begin");
      const scheduled = await scheduleDue(schedulerCaller);
      expect(scheduled.scheduled).toBe(1);

      disablePromise = disabler.query(
        `update public.monitor_execution_settings
         set execution_enabled = false, mode = 'disabled', reason = 'phase4c01 schedule winner'
         where singleton`,
      );
      await waitForLockWait("phase4c01-schedule-disable-waits");

      await schedulerCaller.query("commit");
      await disablePromise;
      disablePromise = null;

      const jobs = await admin!.query(
        `select status::text, lease_token, lease_owner
         from public.check_jobs
         where monitor_id = $1
         order by scheduled_for desc
         limit 1`,
        [MONITOR_SCHEDULE],
      );
      expect(jobs.rows[0]).toMatchObject({
        status: "dead_letter",
        lease_token: null,
        lease_owner: null,
      });
    } finally {
      await Promise.allSettled([
        disablePromise ?? Promise.resolve(),
        schedulerCaller.query("rollback"),
        schedulerCaller.end(),
        disabler.end(),
        setGate(true, "fixtures", "phase4c01 concurrency test"),
      ]);
    }
  });
});
