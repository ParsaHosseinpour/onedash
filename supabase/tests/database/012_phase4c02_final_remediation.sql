-- Phase 4C.0.2 final review remediation: bounded gate cleanup, fail-closed gate
-- recreation, deletion protection, and more than one cleanup batch.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

grant onedash_scheduler to postgres with set true;
grant onedash_queue to postgres with set true;
grant onedash_ingestor to postgres with set true;
grant usage on schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on all functions in schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor;

select no_plan();

-- ============================================================
-- Clean baseline and fixtures
-- ============================================================

-- The seed gate is disabled. Drain any baseline nonterminal rows so the batch
-- size assertions below are exact.
select public.onedash_dead_letter_all_jobs('blocked_target');

create temporary table onedash_4c02_history (
  result_count integer not null,
  job_count integer not null
) on commit drop;

insert into onedash_4c02_history
select
  (select count(*)::int from public.check_results),
  (select count(*)::int from public.check_jobs);

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
select
  ('4c020000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  o.id,
  '11111111-1111-4111-8111-111111111111',
  'Phase 4C.0.2 batch ' || n,
  'https://4c02-batch-' || n || '.acme.test/health',
  300,
  5
from generate_series(1, 11) as n
join public.organizations o on o.slug = 'acme-monitoring';

update public.monitor_execution_settings
set mode = 'fixtures',
    execution_enabled = true,
    reason = 'phase4c02 bounded cleanup test',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

-- Eleven monitors x ten pending jobs = 110 nonterminal jobs, more than one
-- 100-row cleanup batch. One row is leased so gate rejection and lease clearing
-- are exercised too.
insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select
  m.organization_id,
  m.id,
  'test-1',
  now() + make_interval(secs => n * 10),
  now() + make_interval(secs => n * 10),
  '4c02-batch-' || right(m.id::text, 2) || '-' || n,
  'pending'
from public.monitors m
cross join generate_series(1, 10) as n
where m.id::text like '4c020000-0000-4000-8000-%';

create temporary table onedash_4c02_lease on commit drop as
select id, gen_random_uuid() as lease_token
from public.check_jobs
where idempotency_key like '4c02-batch-%'
order by id
limit 1;

update public.check_jobs j
set status = 'leased',
    attempts = 1,
    lease_owner = 'phase4c02-stale-worker',
    lease_token = l.lease_token,
    lease_expires_at = now() + interval '5 minutes'
from onedash_4c02_lease l
where j.id = l.id;

-- The gate-rejection test runs as onedash_ingestor, so the temporary fixture
-- table must be readable by that role.
grant select on onedash_4c02_lease to onedash_ingestor;

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key like '4c02-batch-%'
      and status in ('pending', 'leased')
  ),
  110,
  'the cleanup fixture contains more than one bounded batch of nonterminal jobs'
);

-- ============================================================
-- E-3: disable is immediate and fail-closed
-- ============================================================

update public.monitor_execution_settings
set mode = 'disabled',
    execution_enabled = false,
    reason = 'phase4c02 gate cleanup test',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'gate disable opens a cleanup epoch without scanning every job in the gate transaction'
);

select is(
  (
    select cleanup_completed_at
    from public.monitor_execution_settings
    where singleton
  ),
  null,
  'gate disable does not mark cleanup complete before any batch runs'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key like '4c02-batch-%'
      and status in ('pending', 'leased')
  ),
  110,
  'gate disable leaves nonterminal jobs for bounded cleanup instead of scanning them inline'
);

set local role onedash_scheduler;
select is(
  public.onedash_schedule_due_jobs(10, 0)->>'scheduled',
  '0',
  'the scheduler remains blocked immediately after gate disable'
);
reset role;

set local role onedash_queue;
select is(
  jsonb_array_length(
    public.onedash_claim_jobs(
      'phase4c02-worker', 'test-1', 60, 5, array['phase4c02-batch.test']
    )->'jobs'
  ),
  0,
  'the queue remains blocked immediately after gate disable'
);
reset role;

set local role onedash_ingestor;
select is(
  public.onedash_ingest_check_result(
    (select id from onedash_4c02_lease),
    (select lease_token from onedash_4c02_lease),
    '{"status":"up","http_status":200,"response_time_ms":10,"dns_ms":1,"connect_ms":1,"tls_ms":1,"ttfb_ms":1,"total_ms":10,"redirect_count":0,"response_bytes":100,"checked_at":"2026-01-02T03:04:05Z"}'::jsonb
  )->>'reason',
  'execution_disabled',
  'a disabled gate rejects a leased result before any result write'
);
reset role;

select is(
  (select result_count from onedash_4c02_history),
  (select count(*)::int from public.check_results),
  'the rejected gate ingestion writes no result history'
);

-- ============================================================
-- E-3: bounded batches, re-enable guard, no history deletion
-- ============================================================

create temporary table onedash_4c02_first_batch on commit drop as
select public.onedash_dead_letter_all_jobs('blocked_target') as result;

select is(
  (select result->>'updated' from onedash_4c02_first_batch),
  '100',
  'the first cleanup call processes exactly one 100-row batch'
);

select is(
  (select result->>'remaining' from onedash_4c02_first_batch),
  '10',
  'the first cleanup result reports the ten jobs that remain'
);

select is(
  (select result->>'cleanup_required' from onedash_4c02_first_batch),
  'true',
  'the first cleanup result keeps the epoch open while work remains'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key like '4c02-batch-%'
      and status in ('pending', 'leased')
  ),
  10,
  'ten nonterminal jobs remain after one cleanup batch'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'the cleanup epoch remains open while a second batch is required'
);

select throws_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c02 premature enable'
    where singleton
  $$,
  '23514',
  null,
  'the gate cannot be re-enabled while nonterminal jobs remain'
);

create temporary table onedash_4c02_second_batch on commit drop as
select public.onedash_dead_letter_all_jobs('blocked_target') as result;

select is(
  (select result->>'updated' from onedash_4c02_second_batch),
  '10',
  'the second cleanup call processes the remaining batch'
);

select is(
  (select result->>'remaining' from onedash_4c02_second_batch),
  '0',
  'the second cleanup result reports no nonterminal jobs'
);

select is(
  (select result->>'cleanup_required' from onedash_4c02_second_batch),
  'false',
  'the second cleanup result closes the epoch'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key like '4c02-batch-%'
      and status = 'dead_letter'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and completed_at is null
  ),
  110,
  'every batch row is dead-lettered with all lease and completion fields cleared'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  false,
  'the cleanup epoch closes only after the final batch observes zero nonterminal jobs'
);

select is(
  (select result_count from onedash_4c02_history),
  (select count(*)::int from public.check_results),
  'bounded cleanup never deletes legitimate result history'
);

select is(
  (select job_count from onedash_4c02_history) + 110,
  (select count(*)::int from public.check_jobs),
  'bounded cleanup keeps every job row as dead-letter history'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'updated',
  '0',
  'a zero-row cleanup batch reports zero updated jobs'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'cleanup_required',
  'false',
  'a zero-row cleanup batch is completion only because cleanup_required is false'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c02 cleanup complete',
        egress_verified_at = null,
        egress_verified_by = null
    where singleton
  $$,
  'the gate can be re-enabled after cleanup completes'
);

set local role onedash_queue;
select is(
  jsonb_array_length(
    public.onedash_claim_jobs(
      'phase4c02-worker', 'test-1', 60, 5, array['phase4c02-batch.test']
    )->'jobs'
  ),
  0,
  'dead-lettered old jobs cannot be claimed after the gate is re-enabled'
);
reset role;

-- ============================================================
-- E-4: gate deletion, truncation, and recreation cannot reactivate work
-- ============================================================

select throws_ok(
  'delete from public.monitor_execution_settings where singleton',
  '23514',
  null,
  'direct deletion of the singleton execution-gate row is rejected'
);

select is(
  (select count(*)::int from public.monitor_execution_settings where singleton),
  1,
  'the rejected delete leaves the gate row in place'
);

select throws_ok(
  'truncate table public.monitor_execution_settings',
  '23514',
  null,
  'truncating the execution-gate table is rejected'
);

-- Simulate the only way a privileged owner can reach the documented missing-row
-- state: disable the guard for this transaction, delete the row, then re-enable
-- the guard before testing fail-closed behavior. This does not represent a
-- supported operator path.
alter table public.monitor_execution_settings
  disable trigger monitor_execution_settings_guard_write;
delete from public.monitor_execution_settings where singleton;
alter table public.monitor_execution_settings
  enable trigger monitor_execution_settings_guard_write;

select is(
  public.onedash_execution_status()->>'mode',
  'disabled',
  'a missing gate row is reported as disabled'
);

select is(
  public.onedash_execution_status()->>'cleanup_required',
  'true',
  'a missing gate row reports that cleanup is required'
);

select throws_ok(
  $$
    insert into public.monitor_execution_settings (
      singleton, execution_enabled, mode, reason
    )
    values (true, true, 'fixtures', 'phase4c02 silent reactivation')
  $$,
  '23514',
  null,
  'a recreated gate cannot be inserted directly in enabled fixtures mode'
);

select lives_ok(
  $$
    insert into public.monitor_execution_settings (
      singleton, execution_enabled, mode, reason
    )
    values (true, false, 'disabled', 'phase4c02 restored disabled')
  $$,
  'a recreated gate can be inserted in disabled mode'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'a recreated gate starts with cleanup required even when it is inserted disabled'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c02 restored fixtures'
    where singleton
  $$,
  'a recreated gate can be enabled only after the no-nonterminal-jobs guard passes'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  false,
  'successful re-enable clears the cleanup epoch'
);

select * from finish();
rollback;
