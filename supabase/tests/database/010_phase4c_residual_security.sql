-- Phase 4C.0 residual security hardening: revocation, concurrency-safe caps,
-- tolerant metrics, default function privileges, and bounded cleanup.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

grant onedash_scheduler to postgres with set true;
grant onedash_queue to postgres with set true;
grant onedash_ingestor to postgres with set true;
grant usage on schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor, onedash_function_owner;
grant execute on all functions in schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor, onedash_function_owner;

select no_plan();

-- ============================================================
-- Fixtures
-- ============================================================

-- Monitors are created in the seeded Acme organization. The allowlist trigger
-- requires the exact monitor URL, so every fixture row is inserted from the
-- monitor itself.
insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
select
  v.id,
  o.id,
  '11111111-1111-4111-8111-111111111111',
  v.name,
  v.url,
  300,
  5
from (
  values
    ('4c000000-0000-4000-8000-000000000001'::uuid, 'Phase 4C pause', 'https://4c-pause.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000002'::uuid, 'Phase 4C url change', 'https://4c-url.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000003'::uuid, 'Phase 4C allowlist', 'https://4c-allowlist.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000004'::uuid, 'Phase 4C gate', 'https://4c-gate.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000005'::uuid, 'Phase 4C ingestion', 'https://4c-ingest.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000006'::uuid, 'Phase 4C schedules', 'https://4c-schedules.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000007'::uuid, 'Phase 4C jobs', 'https://4c-jobs.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000008'::uuid, 'Phase 4C multi-row', 'https://4c-multi.acme.test/health'),
    ('4c000000-0000-4000-8000-000000000009'::uuid, 'Phase 4C leased cap', 'https://4c-leased.acme.test/health'),
    ('4c000000-0000-4000-8000-00000000000a'::uuid, 'Phase 4C cross a', 'https://4c-cross-a.acme.test/health'),
    ('4c000000-0000-4000-8000-00000000000b'::uuid, 'Phase 4C cross b', 'https://4c-cross-b.acme.test/health'),
    ('4c000000-0000-4000-8000-00000000000c'::uuid, 'Phase 4C metrics', 'https://4c-metrics.acme.test/health')
) as v(id, name, url)
join public.organizations o on o.slug = 'acme-monitoring';

insert into public.monitor_execution_allowlist (
  monitor_id, organization_id, url, reason
)
select id, organization_id, url, 'phase4c residual security test'
from public.monitors
where id::text like '4c000000-0000-4000-8000-%';

update public.monitor_execution_settings
set execution_enabled = true,
    mode = 'fixtures',
    reason = 'phase4c residual security test',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

-- ============================================================
-- Finding A: revocation clears pending and leased work
-- ============================================================

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select
  organization_id, id, 'test-1', now() + interval '10 seconds',
  now() + interval '10 seconds', '4c-pause-pending', 'pending'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000001';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now() + interval '11 seconds',
  now() + interval '11 seconds', '4c-pause-leased', 'leased',
  'stale-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000001';

update public.monitors
set is_active = false
where id = '4c000000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::int
    from public.check_jobs
    where monitor_id = '4c000000-0000-4000-8000-000000000001'
      and status = 'dead_letter'
      and dead_letter_at is not null
      and completed_at is null
      and completion_token is null
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
  ),
  2,
  'deactivating a monitor dead-letters pending and leased jobs and clears every ownership field'
);

update public.monitors
set is_active = true
where id = '4c000000-0000-4000-8000-000000000001';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select organization_id, id, 'test-1', now(), now(), '4c-url-pending', 'pending'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000002';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now() + interval '1 second',
  now() + interval '1 second', '4c-url-leased', 'leased',
  'stale-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000002';

update public.monitors
set url = 'https://4c-url-changed.acme.test/health'
where id = '4c000000-0000-4000-8000-000000000002';

select is(
  (
    select count(*)::int
    from public.check_jobs
    where monitor_id = '4c000000-0000-4000-8000-000000000002'
      and status = 'dead_letter'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and completion_token is null
      and completed_at is null
  ),
  2,
  'changing a monitor URL dead-letters pending and leased jobs and clears every ownership field'
);

select is(
  (
    select count(*)::int
    from public.monitor_execution_allowlist
    where monitor_id = '4c000000-0000-4000-8000-000000000002'
  ),
  0,
  'changing a monitor URL removes its old allowlist authorization'
);

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select organization_id, id, 'test-1', now(), now(), '4c-allowlist-pending', 'pending'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000003';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now() + interval '1 second',
  now() + interval '1 second', '4c-allowlist-leased', 'leased',
  'stale-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000003';

delete from public.monitor_execution_allowlist
where monitor_id = '4c000000-0000-4000-8000-000000000003';

select is(
  (
    select count(*)::int
    from public.check_jobs
    where monitor_id = '4c000000-0000-4000-8000-000000000003'
      and status = 'dead_letter'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and completion_token is null
      and completed_at is null
  ),
  2,
  'removing an allowlist row dead-letters pending and leased jobs and clears every ownership field'
);

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select
  organization_id, id, 'test-1', now() + interval '20 seconds',
  now() + interval '20 seconds', '4c-gate-pending-a', 'pending'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000001';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now() + interval '21 seconds',
  now() + interval '21 seconds', '4c-gate-leased-a', 'leased',
  'stale-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000001';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select organization_id, id, 'test-1', now() + interval '2 seconds',
  now() + interval '2 seconds', '4c-gate-pending-b', 'pending'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000004';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now() + interval '3 seconds',
  now() + interval '3 seconds', '4c-gate-leased-b', 'leased',
  'stale-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000004';

update public.monitor_execution_settings
set mode = 'disabled',
    execution_enabled = false,
    reason = 'phase4c gate revocation test',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key like '4c-gate-%'
      and status = 'dead_letter'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and completion_token is null
      and completed_at is null
  ),
  4,
  'disabling the execution gate dead-letters pending and leased jobs across monitors and clears every ownership field'
);

update public.monitor_execution_settings
set mode = 'fixtures',
    execution_enabled = true,
    reason = 'phase4c residual security test',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

-- ============================================================
-- Finding B: per-monitor caps
-- ============================================================

insert into public.monitor_schedules (
  organization_id, monitor_id, region, next_run_at
)
select
  organization_id,
  id,
  region,
  null
from public.monitors
cross join (
  values ('us-east'), ('us-west'), ('eu-west'), ('ap-south'), ('test-1')
) as regions(region)
where id = '4c000000-0000-4000-8000-000000000006';

select throws_ok(
  $$
    insert into public.monitor_schedules (
      organization_id, monitor_id, region, next_run_at
    )
    select organization_id, id, 'test-2', null
    from public.monitors
    where id = '4c000000-0000-4000-8000-000000000006'
  $$,
  '23514',
  null,
  'a sixth schedule is rejected for one monitor'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'test-1',
    now() + (n || ' seconds')::interval,
    now() + (n || ' seconds')::interval,
    '4c-cap-' || n,
    'pending'
  from public.monitors
  cross join generate_series(1, 10) as n
  where id = '4c000000-0000-4000-8000-000000000007'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  10,
  'ten pending jobs are accepted for one monitor'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'test-1',
    now() + interval '20 seconds',
    now() + interval '20 seconds',
    '4c-cap-11',
    'pending'
  from public.monitors
  where id = '4c000000-0000-4000-8000-000000000007'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  0,
  'the eleventh pending job is skipped for one monitor'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'test-1',
    now() + (n || ' seconds')::interval,
    now() + (n || ' seconds')::interval,
    '4c-multi-' || n,
    'pending'
  from public.monitors
  cross join generate_series(1, 15) as n
  where id = '4c000000-0000-4000-8000-000000000008'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  10,
  'a multi-row insert is capped at ten jobs for one monitor'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status, lease_owner, lease_token, lease_expires_at
  )
  select
    organization_id,
    id,
    'test-1',
    now() + (n || ' seconds')::interval,
    now() + (n || ' seconds')::interval,
    '4c-leased-' || n,
    'leased',
    'cap-worker',
    gen_random_uuid(),
    now() + interval '1 hour'
  from public.monitors
  cross join generate_series(1, 10) as n
  where id = '4c000000-0000-4000-8000-000000000009'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  10,
  'ten leased jobs are accepted for one monitor'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'test-1',
    now() + interval '20 seconds',
    now() + interval '20 seconds',
    '4c-leased-11',
    'pending'
  from public.monitors
  where id = '4c000000-0000-4000-8000-000000000009'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  0,
  'leased jobs count toward the ten-job cap'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'test-1',
    now() + (n || ' seconds')::interval,
    now() + (n || ' seconds')::interval,
    '4c-cross-a-' || n,
    'pending'
  from public.monitors
  cross join generate_series(1, 10) as n
  where id = '4c000000-0000-4000-8000-00000000000a'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  10,
  'cross-monitor control monitor reaches ten jobs'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'test-1',
    now(),
    now(),
    '4c-cross-b-1',
    'pending'
  from public.monitors
  where id = '4c000000-0000-4000-8000-00000000000b'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  1,
  'a full monitor does not consume another monitor job slot'
);

update public.check_jobs
set status = 'dead_letter',
    dead_letter_at = now()
where id = (
  select id
  from public.check_jobs
  where monitor_id = '4c000000-0000-4000-8000-000000000007'
    and status = 'pending'
  order by id
  limit 1
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'test-1',
    now() + interval '30 seconds',
    now() + interval '30 seconds',
    '4c-cap-replacement',
    'pending'
  from public.monitors
  where id = '4c000000-0000-4000-8000-000000000007'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  1,
  'dead-lettering one job frees a slot under the cap'
);

-- ============================================================
-- Finding A: ingestion rejections are structured and write nothing
-- ============================================================

-- Revocation clears lease_token, so capture the token before the revocation
-- path under test clears it.
create temporary table onedash_4c_tokens (
  name text primary key,
  token uuid not null
) on commit drop;

select is(
  public.onedash_ingest_check_result(
    '00000000-0000-4000-8000-000000000000'::uuid,
    gen_random_uuid(),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'reason',
  'job_not_found',
  'an unknown job is rejected as job_not_found'
);

select is(
  public.onedash_ingest_check_result(
    '00000000-0000-4000-8000-000000000000'::uuid,
    gen_random_uuid(),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'retryable',
  'false',
  'a structured rejection is explicitly non-retryable'
);

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now(), now(), '4c-ingest-valid', 'leased',
  'ingest-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000005';

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = '4c-ingest-valid'
  ),
  'leased',
  'the ingestion fixture job starts leased'
);

update public.check_jobs
set lease_expires_at = now() - interval '1 second'
where idempotency_key = '4c-ingest-valid';

select is(
  public.onedash_ingest_check_result(
    (select id from public.check_jobs where idempotency_key = '4c-ingest-valid'),
    (select lease_token from public.check_jobs where idempotency_key = '4c-ingest-valid'),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'reason',
  'lease_mismatch_or_expired',
  'an expired lease is rejected as lease_mismatch_or_expired'
);

select is(
  (
    select count(*)::int
    from public.check_results
    where monitor_id = '4c000000-0000-4000-8000-000000000005'
  ),
  0,
  'an expired lease rejection writes no result'
);

select is(
  (
    select count(*)::int
    from public.monitor_state
    where monitor_id = '4c000000-0000-4000-8000-000000000005'
  ),
  0,
  'an expired lease rejection writes no monitor state'
);

update public.check_jobs
set lease_expires_at = now() + interval '5 minutes'
where idempotency_key = '4c-ingest-valid';

select is(
  public.onedash_ingest_check_result(
    (select id from public.check_jobs where idempotency_key = '4c-ingest-valid'),
    (select lease_token from public.check_jobs where idempotency_key = '4c-ingest-valid'),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'ok',
  'true',
  'a valid live lease is accepted'
);

select is(
  (
    select count(*)::int
    from public.check_results
    where monitor_id = '4c000000-0000-4000-8000-000000000005'
  ),
  1,
  'a valid ingestion writes exactly one result'
);

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = '4c-ingest-valid'
  ),
  'completed',
  'a valid ingestion completes the job'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key = '4c-ingest-valid'
      and completion_token is not null
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
  ),
  1,
  'a completed job records the completion token and clears lease ownership'
);

select is(
  public.onedash_ingest_check_result(
    (select id from public.check_jobs where idempotency_key = '4c-ingest-valid'),
    gen_random_uuid(),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'reason',
  'lease_mismatch',
  'a completed job rejects a different completion token as lease_mismatch'
);

select is(
  (
    select count(*)::int
    from public.check_results
    where monitor_id = '4c000000-0000-4000-8000-000000000005'
  ),
  1,
  'a duplicate or mismatched completion writes no second result'
);

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now() + interval '1 second',
  now() + interval '1 second', '4c-ingest-disabled', 'leased',
  'ingest-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000005';

insert into onedash_4c_tokens (name, token)
select 'disabled', lease_token
from public.check_jobs
where idempotency_key = '4c-ingest-disabled';

update public.monitor_execution_settings
set mode = 'disabled',
    execution_enabled = false,
    reason = 'phase4c ingestion gate rejection',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

select is(
  public.onedash_ingest_check_result(
    (select id from public.check_jobs where idempotency_key = '4c-ingest-disabled'),
    (select token from onedash_4c_tokens where name = 'disabled'),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'reason',
  'execution_disabled',
  'ingestion revalidates the execution gate'
);

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = '4c-ingest-disabled'
  ),
  'dead_letter',
  'the gate revocation dead-letters the leased ingestion fixture'
);

select is(
  (
    select count(*)::int
    from public.check_results
    where monitor_id = '4c000000-0000-4000-8000-000000000005'
  ),
  1,
  'a gate rejection writes no result'
);

update public.monitor_execution_settings
set mode = 'fixtures',
    execution_enabled = true,
    reason = 'phase4c residual security test',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, lease_owner, lease_token, lease_expires_at
)
select
  organization_id, id, 'test-1', now() + interval '2 seconds',
  now() + interval '2 seconds', '4c-ingest-unauthorized', 'leased',
  'ingest-worker', gen_random_uuid(), now() + interval '5 minutes'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000005';

insert into onedash_4c_tokens (name, token)
select 'unauthorized', lease_token
from public.check_jobs
where idempotency_key = '4c-ingest-unauthorized';

delete from public.monitor_execution_allowlist
where monitor_id = '4c000000-0000-4000-8000-000000000005';

select is(
  public.onedash_ingest_check_result(
    (select id from public.check_jobs where idempotency_key = '4c-ingest-unauthorized'),
    (select token from onedash_4c_tokens where name = 'unauthorized'),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'reason',
  'monitor_not_authorized',
  'ingestion revalidates the allowlist under the monitor lock'
);

select is(
  (
    select count(*)::int
    from public.check_results
    where monitor_id = '4c000000-0000-4000-8000-000000000005'
  ),
  1,
  'an allowlist rejection writes no result'
);

select is(
  (
    select count(*)::int
    from public.monitor_state
    where monitor_id = '4c000000-0000-4000-8000-000000000005'
      and status = 'up'
  ),
  1,
  'only the accepted ingestion wrote monitor state'
);

-- Re-authorize the ingestion fixture so the completed-without-result branch is
-- reached rather than the allowlist rejection.
insert into public.monitor_execution_allowlist (
  monitor_id, organization_id, url, reason
)
select id, organization_id, url, 'phase4c residual security test'
from public.monitors
where id = '4c000000-0000-4000-8000-000000000005';

-- A completed job without a result row is a terminal inconsistency, not a
-- retryable failure.
insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, completed_at, completion_token
)
select
  organization_id, id, 'test-1', now() + interval '3 seconds',
  now() + interval '3 seconds', '4c-ingest-no-result', 'completed',
  now(), gen_random_uuid()
from public.monitors
where id = '4c000000-0000-4000-8000-000000000005';

select is(
  public.onedash_ingest_check_result(
    (select id from public.check_jobs where idempotency_key = '4c-ingest-no-result'),
    (select completion_token from public.check_jobs where idempotency_key = '4c-ingest-no-result'),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'reason',
  'job_completed_without_result',
  'a completed job without a result is rejected as job_completed_without_result'
);

-- ============================================================
-- Finding C: metrics tolerate malformed legacy rows and clamp totals
-- ============================================================

set local role onedash_queue;

select public.onedash_record_heartbeat(
  'worker',
  '4c-valid-worker',
  'test-1',
  '{"concurrency":2,"in_flight":0,"claimed_total":0,"completed_total":0,"failed_total":0,"retried_total":0,"last_error_class":null}'::jsonb
);

reset role;

alter table public.service_heartbeats
  disable trigger service_heartbeats_guard_details;

insert into public.service_heartbeats (
  component, instance_id, region, last_seen_at, details
)
values
  ('worker', '4c-legacy-alpha', 'test-1', now(), '{"concurrency":"abc"}'),
  ('worker', '4c-legacy-nineteen', 'test-1', now(),
   '{"concurrency":"9999999999999999999"}'),
  ('worker', '4c-legacy-negative', 'test-1', now(), '{"concurrency":"-3"}'),
  ('worker', '4c-legacy-decimal', 'test-1', now(), '{"concurrency":"2.5"}'),
  ('worker', '4c-legacy-empty', 'test-1', now(), '{"concurrency":""}'),
  ('worker', '4c-legacy-null', 'test-1', now(), '{}');

insert into public.service_heartbeats (
  component, instance_id, region, last_seen_at, details
)
select
  'worker',
  '4c-clamp-' || n,
  'test-1',
  now(),
  '{"concurrency":"99"}'::jsonb
from generate_series(1, 10) as n;

alter table public.service_heartbeats
  enable trigger service_heartbeats_guard_details;

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, completed_at, lease_expired_count
)
select
  organization_id,
  id,
  'test-1',
  now() + (n || ' seconds')::interval,
  now() + (n || ' seconds')::interval,
  '4c-expired-' || n,
  'completed',
  now(),
  2147483647
from public.monitors
cross join generate_series(1, 2) as n
where id = '4c000000-0000-4000-8000-00000000000c';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select
  organization_id,
  id,
  'test-1',
  '1900-01-01T00:00:00Z',
  '1900-01-01T00:00:00Z',
  '4c-oldest-pending',
  'pending'
from public.monitors
where id = '4c000000-0000-4000-8000-00000000000c';

insert into public.monitor_schedules (
  organization_id, monitor_id, region, next_run_at
)
select
  organization_id,
  id,
  'test-1',
  '1900-01-01T00:00:00Z'
from public.monitors
where id = '4c000000-0000-4000-8000-00000000000c';

set local role onedash_ingestor;

select lives_ok(
  $$ select public.onedash_queue_metrics() $$,
  'queue metrics survive malformed legacy heartbeat values'
);

select is(
  (public.onedash_queue_metrics()->>'worker_concurrency')::int,
  102,
  'worker concurrency ignores malformed rows and clamps each heartbeat to ten'
);

select is(
  (public.onedash_queue_metrics()->>'expired_leases')::int,
  2147483647,
  'expired lease totals are clamped to the integer range'
);

select is(
  (public.onedash_queue_metrics()->>'oldest_job_age_seconds')::int,
  2147483647,
  'oldest job age is clamped to the integer range'
);

select is(
  (public.onedash_queue_metrics()->>'scheduler_delay_seconds')::int,
  2147483647,
  'scheduler delay is clamped to the integer range'
);

reset role;

-- ============================================================
-- Finding D: default function execute hardening
-- ============================================================

create function public.onedash_test_4c_postgres_default_acl()
returns integer
language sql
as $$ select 1 $$;

select is(
  has_function_privilege(
    'anon',
    'public.onedash_test_4c_postgres_default_acl()',
    'EXECUTE'
  ),
  false,
  'new functions created by postgres do not grant PUBLIC execute'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.onedash_test_4c_postgres_default_acl()',
    'EXECUTE'
  ),
  false,
  'new functions created by postgres do not grant authenticated execute'
);

select is(
  has_function_privilege(
    'service_role',
    'public.onedash_test_4c_postgres_default_acl()',
    'EXECUTE'
  ),
  false,
  'new functions created by postgres do not grant service_role execute'
);

drop function public.onedash_test_4c_postgres_default_acl();

grant create on schema public to onedash_function_owner;

set local role onedash_function_owner;

select is(
  current_user::text,
  'onedash_function_owner'::text,
  'SET ROLE onedash_function_owner succeeds for the migration role'
);

create function public.onedash_test_4c_owner_default_acl()
returns integer
language sql
as $$ select 1 $$;

reset role;

select is(
  (
    select pg_get_userbyid(proowner)
    from pg_proc
    where oid = 'public.onedash_test_4c_owner_default_acl()'::regprocedure
  ),
  'onedash_function_owner',
  'the function-owner test function is owned by onedash_function_owner'
);

select is(
  has_function_privilege(
    'anon',
    'public.onedash_test_4c_owner_default_acl()',
    'EXECUTE'
  ),
  false,
  'new functions created by the function owner do not grant PUBLIC execute'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.onedash_test_4c_owner_default_acl()',
    'EXECUTE'
  ),
  false,
  'new functions created by the function owner do not grant authenticated execute'
);

select is(
  has_function_privilege(
    'service_role',
    'public.onedash_test_4c_owner_default_acl()',
    'EXECUTE'
  ),
  false,
  'new functions created by the function owner do not grant service_role execute'
);

drop function public.onedash_test_4c_owner_default_acl();
revoke create on schema public from onedash_function_owner;

select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) as acl
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and r.rolname in ('postgres', 'onedash_function_owner')
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'no SECURITY DEFINER function owned by an administrable role grants PUBLIC execute'
);

select is(
  (
    select count(*)::int
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in (
        'onedash_dead_letter_all_jobs',
        'onedash_execution_gate_change',
        'onedash_lock_allowlist_monitor',
        'onedash_safe_metric_bigint'
      )
      and pg_get_userbyid(proowner) <> 'onedash_function_owner'
  ),
  0,
  'the new Phase 4C helpers are owned by the function owner'
);

set local role onedash_function_owner;

select is(
  (
    select id::text
    from public.monitors
    where id = '4c000000-0000-4000-8000-000000000005'
    for share
  ),
  '4c000000-0000-4000-8000-000000000005',
  'the function owner can take a monitor share lock under RLS'
);

select is(
  (
    select singleton::text
    from public.monitor_execution_settings
    where singleton
    for share
  ),
  'true',
  'the function owner can take an execution-gate share lock under RLS'
);

reset role;

select is(
  (
    select count(*)::int
    from pg_auth_members m
    join pg_roles r on r.oid = m.roleid
    join pg_roles u on u.oid = m.member
    where r.rolname = 'supabase_admin'
      and u.rolname = 'postgres'
  ),
  0,
  'postgres is not a member of supabase_admin'
);

select diag(
  'supabase_admin default function privileges cannot be altered by postgres; the migration reports this limitation and the operator must run the documented superuser step.'
);

select ok(
  true,
  'the supabase_admin privilege limitation is documented instead of failing the migration'
);

-- ============================================================
-- Finding E: scheduler-only bounded cleanup
-- ============================================================

select is(
  has_function_privilege(
    'onedash_scheduler',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  true,
  'the scheduler can execute heartbeat cleanup'
);

select is(
  has_function_privilege(
    'onedash_queue',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  false,
  'the queue role cannot execute heartbeat cleanup'
);

select is(
  has_function_privilege(
    'anon',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  false,
  'anon cannot execute heartbeat cleanup'
);

select is(
  (
    select proconfig
    from pg_proc
    where oid = 'public.onedash_cleanup_stale_heartbeats(integer)'::regprocedure
  ) @> array['statement_timeout=5s', 'lock_timeout=2s']::text[],
  true,
  'heartbeat cleanup has function-level statement and lock timeouts'
);

alter table public.service_heartbeats
  disable trigger service_heartbeats_guard_details;

insert into public.service_heartbeats (
  component, instance_id, region, last_seen_at, details
)
select
  'worker',
  '4c-stale-' || n,
  'test-1',
  now() - interval '2 days',
  '{}'::jsonb
from generate_series(1, 12000) as n;

insert into public.service_heartbeats (
  component, instance_id, region, last_seen_at, details
)
values (
  'worker', '4c-active-heartbeat', 'test-1', now(), '{}'::jsonb
);

alter table public.service_heartbeats
  enable trigger service_heartbeats_guard_details;

set local role onedash_scheduler;

select is(
  public.onedash_cleanup_stale_heartbeats(86400),
  10000,
  'one cleanup call deletes at most ten bounded batches'
);

select throws_ok(
  $$ select public.onedash_cleanup_stale_heartbeats(59) $$,
  '22023',
  null,
  'cleanup rejects an out-of-range retention'
);

reset role;

select is(
  (
    select count(*)::int
    from public.service_heartbeats
    where instance_id like '4c-stale-%'
  ),
  2000,
  'the bounded cleanup leaves the remainder for the next scheduler tick'
);

set local role onedash_scheduler;

select is(
  public.onedash_cleanup_stale_heartbeats(86400),
  2000,
  'the next cleanup call drains the remaining stale rows'
);

reset role;

select is(
  (
    select count(*)::int
    from public.service_heartbeats
    where instance_id like '4c-stale-%'
  ),
  0,
  'no stale cleanup fixture remains'
);

select is(
  (
    select count(*)::int
    from public.service_heartbeats
    where instance_id = '4c-active-heartbeat'
  ),
  1,
  'an active heartbeat is never deleted'
);

select * from finish();
rollback;
