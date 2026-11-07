-- Phase 4B scheduler, queue, and ingestion permissions.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

-- The local test runner connects as postgres. Allow it to assume the
-- NOLOGIN group roles so the restricted-function grants can be exercised.
grant onedash_scheduler to postgres with set true;
grant onedash_queue to postgres with set true;
grant onedash_ingestor to postgres with set true;

select no_plan();

-- ============================================================
-- Role separation
-- ============================================================
select is(
  (select rolcanlogin from pg_roles where rolname = 'onedash_scheduler'),
  false,
  'scheduler group role exists and cannot log in directly'
);

select is(
  (select rolcanlogin from pg_roles where rolname = 'onedash_queue'),
  false,
  'queue group role exists and cannot log in directly'
);

select is(
  (select rolcanlogin from pg_roles where rolname = 'onedash_ingestor'),
  false,
  'ingestor group role exists and cannot log in directly'
);

-- The legacy worker role must not retain data or function access.
select is(
  has_table_privilege('onedash_worker', 'public.monitors', 'SELECT'),
  false,
  'legacy worker cannot read monitors'
);

select is(
  has_table_privilege('onedash_worker', 'public.check_jobs', 'SELECT'),
  false,
  'legacy worker cannot read scheduler jobs'
);

select is(
  has_table_privilege('onedash_worker', 'public.check_results', 'SELECT'),
  false,
  'legacy worker cannot read check results'
);

select is(
  has_table_privilege('onedash_worker', 'public.alert_channel_secrets', 'SELECT'),
  false,
  'legacy worker cannot read alert credentials'
);

select is(
  has_function_privilege(
    'onedash_worker',
    'public.onedash_claim_jobs(text,text,integer,integer,text[])',
    'EXECUTE'
  ),
  false,
  'legacy worker cannot claim scheduler jobs'
);

select is(
  has_function_privilege(
    'onedash_worker',
    'public.onedash_ingest_check_result(uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  false,
  'legacy worker cannot ingest check results'
);

-- ============================================================
-- Split function grants
-- ============================================================
select ok(
  has_function_privilege(
    'onedash_scheduler',
    'public.onedash_schedule_due_jobs(integer,integer)',
    'EXECUTE'
  ),
  'scheduler can schedule due jobs'
);

select ok(
  has_function_privilege(
    'onedash_scheduler',
    'public.onedash_reap_expired_leases(integer)',
    'EXECUTE'
  ),
  'scheduler can reap expired leases'
);

select ok(
  has_function_privilege(
    'onedash_scheduler',
    'public.onedash_record_heartbeat(text,text,text,jsonb)',
    'EXECUTE'
  ),
  'scheduler can record heartbeats'
);

select ok(
  has_function_privilege(
    'onedash_scheduler',
    'public.onedash_queue_metrics()',
    'EXECUTE'
  ),
  'scheduler can read aggregate queue metrics'
);

select ok(
  not has_function_privilege(
    'onedash_scheduler',
    'public.onedash_claim_jobs(text,text,integer,integer,text[])',
    'EXECUTE'
  ),
  'scheduler cannot claim jobs'
);

select ok(
  not has_function_privilege(
    'onedash_scheduler',
    'public.onedash_ingest_check_result(uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'scheduler cannot ingest results'
);

select ok(
  has_function_privilege(
    'onedash_queue',
    'public.onedash_claim_jobs(text,text,integer,integer,text[])',
    'EXECUTE'
  ),
  'queue can claim jobs'
);

select ok(
  has_function_privilege(
    'onedash_queue',
    'public.onedash_extend_lease(uuid,uuid,integer)',
    'EXECUTE'
  ),
  'queue can extend leases'
);

select ok(
  has_function_privilege(
    'onedash_queue',
    'public.onedash_release_job(uuid,uuid)',
    'EXECUTE'
  ),
  'queue can release jobs'
);

select ok(
  has_function_privilege(
    'onedash_queue',
    'public.onedash_fail_job(uuid,uuid,text,boolean)',
    'EXECUTE'
  ),
  'queue can fail jobs'
);

select ok(
  has_function_privilege(
    'onedash_queue',
    'public.onedash_acknowledge_job(uuid,uuid)',
    'EXECUTE'
  ),
  'queue can acknowledge jobs'
);

select ok(
  not has_function_privilege(
    'onedash_queue',
    'public.onedash_schedule_due_jobs(integer,integer)',
    'EXECUTE'
  ),
  'queue cannot schedule jobs'
);

select ok(
  not has_function_privilege(
    'onedash_queue',
    'public.onedash_ingest_check_result(uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'queue cannot ingest results'
);

select ok(
  has_function_privilege(
    'onedash_ingestor',
    'public.onedash_ingest_check_result(uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'ingestor can ingest results'
);

select ok(
  has_function_privilege(
    'onedash_ingestor',
    'public.onedash_acknowledge_job(uuid,uuid)',
    'EXECUTE'
  ),
  'ingestor can acknowledge jobs'
);

select ok(
  has_function_privilege(
    'onedash_ingestor',
    'public.onedash_queue_metrics()',
    'EXECUTE'
  ),
  'ingestor can read aggregate queue metrics'
);

select ok(
  not has_function_privilege(
    'onedash_ingestor',
    'public.onedash_claim_jobs(text,text,integer,integer,text[])',
    'EXECUTE'
  ),
  'ingestor cannot claim jobs'
);

select ok(
  not has_function_privilege(
    'onedash_ingestor',
    'public.onedash_schedule_due_jobs(integer,integer)',
    'EXECUTE'
  ),
  'ingestor cannot schedule jobs'
);

select ok(
  not has_function_privilege(
    'onedash_ingestor',
    'public.onedash_record_heartbeat(text,text,text,jsonb)',
    'EXECUTE'
  ),
  'ingestor cannot record worker heartbeats'
);

-- None of the split roles may read the queue table directly.
select is(
  has_table_privilege('onedash_scheduler', 'public.check_jobs', 'SELECT'),
  false,
  'scheduler has no direct check_jobs access'
);

select is(
  has_table_privilege('onedash_queue', 'public.check_jobs', 'SELECT'),
  false,
  'queue has no direct check_jobs access'
);

select is(
  has_table_privilege('onedash_ingestor', 'public.check_results', 'SELECT'),
  false,
  'ingestor has no direct check_results access'
);

select is(
  has_table_privilege('onedash_scheduler', 'public.monitors', 'SELECT'),
  false,
  'scheduler has no direct monitor access'
);

select is(
  has_table_privilege('onedash_queue', 'public.monitor_request_secrets', 'SELECT'),
  false,
  'queue has no direct request-secret access'
);

select is(
  has_table_privilege('onedash_ingestor', 'public.monitor_request_secrets', 'SELECT'),
  false,
  'ingestor has no direct request-secret access'
);

-- ============================================================
-- Queue table, RLS, and execution gate invariants
-- ============================================================
select is(
  (select relrowsecurity from pg_class where oid = 'public.check_jobs'::regclass),
  true,
  'check_jobs has RLS enabled'
);

select is(
  (select relrowsecurity from pg_class where oid = 'public.service_heartbeats'::regclass),
  true,
  'service_heartbeats has RLS enabled'
);

select is(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.monitor_execution_settings'::regclass
  ),
  true,
  'monitor_execution_settings has RLS enabled'
);

select is(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.monitor_execution_allowlist'::regclass
  ),
  true,
  'monitor_execution_allowlist has RLS enabled'
);

select is(
  (
    select count(*)::int
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'check_jobs',
        'service_heartbeats',
        'monitor_execution_settings',
        'monitor_execution_allowlist'
      )
      and roles && array['anon', 'authenticated']::name[]
  ),
  0,
  'Phase 4B tables have no direct application RLS policies'
);

select is(
  (
    select execution_enabled
    from public.monitor_execution_settings
    where singleton
  ),
  false,
  'customer execution is disabled by default'
);

select is(
  (
    select mode
    from public.monitor_execution_settings
    where singleton
  ),
  'disabled',
  'execution mode is disabled by default'
);

select is(
  (
    select count(*)::int
    from pg_constraint
    where conname = 'check_jobs_idempotency_key_key'
  ),
  1,
  'check_jobs has a unique idempotency key'
);

select is(
  (
    select count(*)::int
    from pg_constraint
    where conname = 'check_jobs_monitor_region_scheduled_key'
  ),
  1,
  'check_jobs has a unique monitor/region/scheduled slot'
);

select is(
  (
    select count(*)::int
    from pg_constraint
    where conname in (
      'check_jobs_lease_check',
      'check_jobs_completed_check',
      'check_jobs_dead_letter_check',
      'check_jobs_attempts_max_check'
    )
  ),
  4,
  'check_jobs terminal, lease, and attempt constraints exist'
);

-- ============================================================
-- Restricted-role execution smoke checks
-- ============================================================
-- Test-only grants so pgTAP assertions can run while impersonating each
-- restricted role. These grants are rolled back with the transaction.
grant usage on schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on all functions in schema extensions to
  onedash_scheduler, onedash_queue, onedash_ingestor;

update public.monitor_execution_settings
set mode = 'disabled', execution_enabled = false
where singleton;

set local role onedash_scheduler;

select lives_ok(
  'select public.onedash_execution_status()',
  'scheduler can read the execution status'
);

select lives_ok(
  'select public.onedash_schedule_due_jobs(1, 0)',
  'scheduler can run a scheduling tick while the gate is disabled'
);

select lives_ok(
  'select public.onedash_reap_expired_leases(1)',
  'scheduler can reap expired leases'
);

select lives_ok(
  'select public.onedash_queue_metrics()',
  'scheduler can read queue metrics'
);

select throws_ok(
  $$ select public.onedash_claim_jobs(
       'test-worker', 'test-1', 60, 1, array['fixture.test']
     ) $$,
  '42501',
  null,
  'scheduler cannot call the claim function'
);

select throws_ok(
  $$ select public.onedash_ingest_check_result(
       '00000000-0000-4000-8000-000000000001'::uuid,
       '00000000-0000-4000-8000-000000000002'::uuid,
       '{}'::jsonb
     ) $$,
  '42501',
  null,
  'scheduler cannot call the ingestion function'
);

reset role;
set local role onedash_queue;

select lives_ok(
  'select public.onedash_execution_status()',
  'queue can read the execution status'
);

select lives_ok(
  $$ select public.onedash_claim_jobs(
       'test-worker', 'test-1', 60, 1, array['fixture.test']
     ) $$,
  'queue can call the claim function while the gate is disabled'
);

select lives_ok(
  'select public.onedash_reap_expired_leases(1)',
  'queue can reap expired leases'
);

select lives_ok(
  'select public.onedash_queue_metrics()',
  'queue can read queue metrics'
);

select throws_ok(
  'select public.onedash_schedule_due_jobs(1, 0)',
  '42501',
  null,
  'queue cannot call the scheduler function'
);

select throws_ok(
  $$ select public.onedash_ingest_check_result(
       '00000000-0000-4000-8000-000000000001'::uuid,
       '00000000-0000-4000-8000-000000000002'::uuid,
       '{}'::jsonb
     ) $$,
  '42501',
  null,
  'queue cannot call the ingestion function'
);

reset role;
set local role onedash_ingestor;

select lives_ok(
  'select public.onedash_execution_status()',
  'ingestor can read the execution status'
);

select lives_ok(
  'select public.onedash_queue_metrics()',
  'ingestor can read queue metrics'
);

select throws_ok(
  $$ select public.onedash_claim_jobs(
       'test-worker', 'test-1', 60, 1, array['fixture.test']
     ) $$,
  '42501',
  null,
  'ingestor cannot call the claim function'
);

select throws_ok(
  'select public.onedash_schedule_due_jobs(1, 0)',
  '42501',
  null,
  'ingestor cannot call the scheduler function'
);

select throws_ok(
  $$ select public.onedash_record_heartbeat(
       'worker', 'test-worker', 'test-1', '{}'::jsonb
     ) $$,
  '42501',
  null,
  'ingestor cannot record worker heartbeats'
);

reset role;

select * from finish();
rollback;
