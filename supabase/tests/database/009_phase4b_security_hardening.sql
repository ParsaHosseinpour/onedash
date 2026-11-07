-- Phase 4B security hardening: privileges, bounded write paths, URL-bound
-- fixture authorization, strict heartbeat schema, and least-privilege function
-- ownership.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

-- Test-only role membership so pgTAP can exercise the restricted groups.
grant onedash_scheduler to postgres with set true;
grant onedash_queue to postgres with set true;
grant onedash_ingestor to postgres with set true;
grant usage on schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on all functions in schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor;

select no_plan();

-- ============================================================
-- Dedicated function-owner role
-- ============================================================

select is(
  (select rolcanlogin from pg_roles where rolname = 'onedash_function_owner'),
  false,
  'function owner cannot log in'
);

select is(
  (select rolsuper from pg_roles where rolname = 'onedash_function_owner'),
  false,
  'function owner is not a superuser'
);

select is(
  (
    select count(*)::int
    from pg_auth_members m
    join pg_roles r on r.oid = m.roleid
    where r.rolname = 'onedash_function_owner'
      and pg_get_userbyid(m.member) in (
        'anon',
        'authenticated',
        'service_role',
        'onedash_scheduler',
        'onedash_queue',
        'onedash_ingestor'
      )
  ),
  0,
  'no application role is a member of the function owner'
);

select is(
  (
    select count(*)::int
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in (
        'onedash_schedule_due_jobs',
        'onedash_claim_jobs',
        'onedash_extend_lease',
        'onedash_release_job',
        'onedash_fail_job',
        'onedash_reap_expired_leases',
        'onedash_acknowledge_job',
        'onedash_ingest_check_result',
        'onedash_record_heartbeat'
      )
      and pg_get_userbyid(proowner) <> 'onedash_function_owner'
  ),
  0,
  'all Phase 4B SECURITY DEFINER entry points are owned by the function owner'
);

-- A function created by the migration role must not regain the PostgreSQL
-- default PUBLIC EXECUTE grant.
create function public.onedash_test_default_acl()
returns integer
language sql
as $$ select 1 $$;

select is(
  has_function_privilege('anon', 'public.onedash_test_default_acl()', 'EXECUTE'),
  false,
  'new functions created by the migration role do not grant PUBLIC execute'
);

drop function public.onedash_test_default_acl();

-- ============================================================
-- Function and table privilege denial
-- ============================================================

select ok(
  not has_function_privilege(
    'anon',
    'public.onedash_claim_jobs(text,text,integer,integer,text[])',
    'EXECUTE'
  ),
  'anon cannot execute the claim function'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.onedash_claim_jobs(text,text,integer,integer,text[])',
    'EXECUTE'
  ),
  'authenticated cannot execute the claim function'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.onedash_claim_jobs(text,text,integer,integer,text[])',
    'EXECUTE'
  ),
  'service_role cannot execute the claim function'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.onedash_ingest_check_result(uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute the ingestion function'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.onedash_record_heartbeat(text,text,text,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute the heartbeat function'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.onedash_schedule_due_jobs(integer,integer)',
    'EXECUTE'
  ),
  'authenticated cannot execute the scheduler function'
);

select is(
  has_table_privilege('anon', 'public.check_jobs', 'SELECT'),
  false,
  'anon has no direct check_jobs access'
);

select is(
  has_table_privilege('authenticated', 'public.check_jobs', 'SELECT'),
  false,
  'authenticated has no direct check_jobs access'
);

select is(
  has_table_privilege('anon', 'public.service_heartbeats', 'SELECT'),
  false,
  'anon has no direct heartbeat access'
);

select is(
  has_table_privilege('authenticated', 'public.monitor_execution_allowlist', 'SELECT'),
  false,
  'authenticated has no direct allowlist access'
);

select is(
  (
    select count(*)::int
    from unnest(
      array[
        'public.check_jobs',
        'public.service_heartbeats',
        'public.monitor_execution_settings',
        'public.monitor_execution_allowlist',
        'public.supported_regions'
      ]
    ) as t(name)
    cross join unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
    where has_table_privilege('service_role', t.name, p.privilege)
  ),
  0,
  'service_role has no TRUNCATE, REFERENCES, or TRIGGER on Phase 4B tables'
);

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    if exists (
      select 1
      from unnest(
        array[
          'public.check_jobs',
          'public.service_heartbeats',
          'public.monitor_execution_settings',
          'public.monitor_execution_allowlist',
          'public.supported_regions'
        ]
      ) as t(name)
      where has_table_privilege('service_role', t.name, 'MAINTAIN')
    ) then
      raise exception 'service_role retains MAINTAIN on a Phase 4B table';
    end if;
  end if;
end $$;

select is(
  (
    select count(*)::int
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'check_jobs',
        'service_heartbeats',
        'monitor_execution_settings',
        'monitor_execution_allowlist',
        'supported_regions'
      )
      and roles && array['anon', 'authenticated']::name[]
  ),
  0,
  'application roles have no direct policies on hardening tables'
);

-- ============================================================
-- Bounded region registry
-- ============================================================

select is(
  (
    select count(*)::int
    from public.supported_regions
    where enabled
  ),
  8,
  'region registry contains the eight supported regions'
);

select is(
  has_table_privilege('authenticated', 'public.supported_regions', 'SELECT'),
  false,
  'authenticated cannot read the region registry directly'
);

select is(
  has_table_privilege('service_role', 'public.supported_regions', 'SELECT'),
  false,
  'service_role cannot read the region registry directly'
);

-- ============================================================
-- Test monitors
-- ============================================================

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
select
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  o.id,
  '11111111-1111-4111-8111-111111111111',
  'Allowlist guard fixture',
  'https://guard.acme.test/health',
  300,
  5
from public.organizations o
where o.slug = 'acme-monitoring';

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
select
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  o.id,
  '11111111-1111-4111-8111-111111111111',
  'Schedule guard fixture',
  'https://schedule.acme.test/health',
  300,
  5
from public.organizations o
where o.slug = 'acme-monitoring';

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
select
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  o.id,
  '11111111-1111-4111-8111-111111111111',
  'Bounded write fixture',
  'https://bounded.acme.test/health',
  300,
  5
from public.organizations o
where o.slug = 'acme-monitoring';

-- ============================================================
-- Allowlist URL binding and revocation
-- ============================================================

select is(
  (
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'monitor_execution_allowlist'
      and column_name = 'url'
  ),
  'NO',
  'allowlist URL is required'
);

select throws_ok(
  $$
    insert into public.monitor_execution_allowlist (
      monitor_id, organization_id, url, reason
    )
    select id, organization_id, 'https://other.acme.test/health', 'mismatch'
    from public.monitors
    where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  $$,
  '22023',
  null,
  'allowlist rejects a URL that differs from the monitor URL'
);

insert into public.monitor_execution_allowlist (
  monitor_id, organization_id, url, reason
)
select id, organization_id, url, 'guard test'
from public.monitors
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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
  'guard-url-change',
  'pending'
from public.monitors
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

update public.monitors
set url = 'https://changed.acme.test/health'
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

select is(
  (
    select count(*)::int
    from public.monitor_execution_allowlist
    where monitor_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ),
  0,
  'changing a monitor URL deletes its allowlist authorization'
);

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = 'guard-url-change'
  ),
  'dead_letter',
  'changing a monitor URL dead-letters its pending jobs'
);

insert into public.monitor_execution_allowlist (
  monitor_id, organization_id, url, reason
)
select id, organization_id, url, 'guard test reactivated'
from public.monitors
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select
  organization_id,
  id,
  'test-1',
  now() + interval '1 second',
  now() + interval '1 second',
  'guard-deactivate',
  'pending'
from public.monitors
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

update public.monitors
set is_active = false
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = 'guard-deactivate'
  ),
  'dead_letter',
  'deactivating a monitor dead-letters its pending jobs'
);

update public.monitors
set is_active = true
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status
)
select
  organization_id,
  id,
  'test-1',
  now() + interval '2 seconds',
  now() + interval '2 seconds',
  'guard-allowlist-delete',
  'pending'
from public.monitors
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

delete from public.monitor_execution_allowlist
where monitor_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = 'guard-allowlist-delete'
  ),
  'dead_letter',
  'removing an allowlist row dead-letters pending jobs'
);

insert into public.monitor_execution_allowlist (
  monitor_id, organization_id, url, reason
)
select id, organization_id, url, 'test reauthorization'
from public.monitors
where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = 'guard-allowlist-delete'
  ),
  'dead_letter',
  're-adding an allowlist row does not resurrect a dead-lettered job'
);

-- ============================================================
-- Fixture host allowlist negatives
-- ============================================================

update public.monitor_execution_settings
set execution_enabled = true,
    mode = 'fixtures',
    reason = 'pgtap host allowlist negatives',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

set local role onedash_queue;

select throws_ok(
  $$ select public.onedash_claim_jobs(
       'host-guard', 'test-1', 60, 1, array['customer.example']
     ) $$,
  '22023',
  'invalid fixture host allowlist',
  'public domains are rejected by the claim allowlist'
);

select throws_ok(
  $$ select public.onedash_claim_jobs(
       'host-guard', 'test-1', 60, 1, array['localhost']
     ) $$,
  '22023',
  'invalid fixture host allowlist',
  'localhost is rejected by the claim allowlist'
);

select throws_ok(
  $$ select public.onedash_claim_jobs(
       'host-guard', 'test-1', 60, 1, array['api.localhost']
     ) $$,
  '22023',
  'invalid fixture host allowlist',
  'localhost subdomains are rejected by the claim allowlist'
);

select throws_ok(
  $$ select public.onedash_claim_jobs(
       'host-guard', 'test-1', 60, 1, array['127.0.0.1']
     ) $$,
  '22023',
  'invalid fixture host allowlist',
  'IP literals are rejected by the claim allowlist'
);

-- ============================================================
-- Schedule ownership and bounded writes
-- ============================================================

set local request.jwt.claims =
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;

select throws_ok(
  $$
    insert into public.monitor_schedules (
      organization_id, monitor_id, region, next_run_at
    )
    select organization_id, id, 'us-west', now()
    from public.monitors
    where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $$,
  '42501',
  null,
  'ordinary users cannot choose next_run_at'
);

select lives_ok(
  $$
    insert into public.monitor_schedules (
      organization_id, monitor_id, region, next_run_at
    )
    select organization_id, id, 'us-west', null
    from public.monitors
    where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $$,
  'ordinary users can create a schedule without scheduler-owned fields'
);

select throws_ok(
  $$
    update public.monitor_schedules
    set next_run_at = now()
    where monitor_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $$,
  '42501',
  null,
  'ordinary users cannot change next_run_at'
);

select throws_ok(
  $$
    update public.monitor_schedules
    set region = 'eu-west'
    where monitor_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $$,
  '42501',
  null,
  'ordinary users cannot change region'
);

select throws_ok(
  $$
    update public.monitor_schedules
    set last_run_at = now()
    where monitor_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $$,
  '42501',
  null,
  'ordinary users cannot change last_run_at'
);

select throws_ok(
  $$
    update public.monitor_schedules
    set lease_expires_at = now()
    where monitor_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  $$,
  '42501',
  null,
  'ordinary users cannot change lease_expires_at'
);

reset role;

insert into public.monitor_schedules (
  organization_id, monitor_id, region, next_run_at
)
select organization_id, id, region, null
from public.monitors
cross join (
  values ('us-east'), ('us-west'), ('eu-west'), ('ap-south'), ('test-1')
) as regions(region)
where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

select throws_ok(
  $$
    insert into public.monitor_schedules (
      organization_id, monitor_id, region, next_run_at
    )
    select organization_id, id, 'test-2', null
    from public.monitors
    where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  $$,
  '23514',
  null,
  'a monitor cannot exceed five schedules'
);

with inserted as (
  insert into public.check_jobs (
    organization_id, monitor_id, region, scheduled_for, available_at,
    idempotency_key, status
  )
  select
    organization_id,
    id,
    'us-east',
    now() + (n || ' seconds')::interval,
    now() + (n || ' seconds')::interval,
    'flood-' || n,
    'pending'
  from public.monitors
  cross join generate_series(1, 11) as n
  where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  returning 1
)
select is(
  (select count(*)::int from inserted),
  10,
  'the pending job cap skips inserts beyond ten jobs per monitor'
);

select throws_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status
    )
    select
      organization_id,
      id,
      'moon-1',
      now() + interval '1 minute',
      now() + interval '1 minute',
      'unsupported-region',
      'pending'
    from public.monitors
    where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  $$,
  '23503',
  null,
  'jobs reject regions outside the supported registry'
);

-- ============================================================
-- Strict heartbeat schema and cleanup
-- ============================================================

set local role onedash_scheduler;

select lives_ok(
  $$
    select public.onedash_record_heartbeat(
      'scheduler',
      'pgtap-scheduler',
      'global',
      '{"batch_size":10,"jitter_seconds":0,"last_scheduled":0,"last_skipped":0,"execution_mode":"fixtures"}'::jsonb
    )
  $$,
  'scheduler heartbeat with the strict schema is accepted'
);

select throws_ok(
  $$
    select public.onedash_record_heartbeat(
      'scheduler',
      'pgtap-bad-scheduler',
      'global',
      '{"batch_size":10,"jitter_seconds":0,"last_scheduled":0,"last_skipped":0,"execution_mode":"fixtures","url":"https://customer.example"}'::jsonb
    )
  $$,
  '22023',
  null,
  'scheduler heartbeat rejects an extra URL field'
);

select throws_ok(
  $$
    select public.onedash_record_heartbeat(
      'scheduler',
      'pgtap-case-scheduler',
      'global',
      '{"Batch_Size":10,"jitter_seconds":0,"last_scheduled":0,"last_skipped":0,"execution_mode":"fixtures"}'::jsonb
    )
  $$,
  '22023',
  null,
  'scheduler heartbeat rejects case-variant fields'
);

select throws_ok(
  $$
    select public.onedash_record_heartbeat(
      'scheduler',
      'pgtap-nested-scheduler',
      'global',
      '{"batch_size":10,"jitter_seconds":0,"last_scheduled":0,"last_skipped":{"value":0},"execution_mode":"fixtures"}'::jsonb
    )
  $$,
  '22023',
  null,
  'scheduler heartbeat rejects nested values'
);

reset role;
set local role onedash_queue;

select lives_ok(
  $$
    select public.onedash_record_heartbeat(
      'worker',
      'pgtap-worker',
      'test-1',
      '{"concurrency":2,"in_flight":0,"claimed_total":0,"completed_total":0,"failed_total":0,"retried_total":0,"last_error_class":null}'::jsonb
    )
  $$,
  'worker heartbeat with the strict schema is accepted'
);

select throws_ok(
  $$
    select public.onedash_record_heartbeat(
      'worker',
      'pgtap-high-concurrency',
      'test-1',
      '{"concurrency":11,"in_flight":0,"claimed_total":0,"completed_total":0,"failed_total":0,"retried_total":0,"last_error_class":null}'::jsonb
    )
  $$,
  '22023',
  null,
  'worker heartbeat rejects concurrency above the bound'
);

select throws_ok(
  $$
    select public.onedash_record_heartbeat(
      'worker',
      'pgtap-sensitive-worker',
      'test-1',
      '{"concurrency":2,"in_flight":0,"claimed_total":0,"completed_total":0,"failed_total":0,"retried_total":0,"last_error_class":null,"API_KEY":"secret"}'::jsonb
    )
  $$,
  '22023',
  null,
  'worker heartbeat rejects a case-variant sensitive field'
);

select lives_ok(
  $$
    select public.onedash_record_heartbeat(
      'worker',
      'pgtap-cleanup-worker',
      'test-1',
      '{"concurrency":2,"in_flight":0,"claimed_total":0,"completed_total":0,"failed_total":0,"retried_total":0,"last_error_class":null}'::jsonb
    )
  $$,
  'cleanup heartbeat fixture is recorded'
);

reset role;

update public.service_heartbeats
set last_seen_at = now() - interval '2 days'
where component = 'worker'
  and instance_id = 'pgtap-cleanup-worker';

set local role onedash_scheduler;

select is(
  public.onedash_cleanup_stale_heartbeats(86400),
  1,
  'heartbeat cleanup deletes exactly the stale row'
);

reset role;

select is(
  (
    select count(*)::int
    from public.service_heartbeats
    where instance_id = 'pgtap-cleanup-worker'
  ),
  0,
  'stale heartbeat row is gone after cleanup'
);

select * from finish();
rollback;
