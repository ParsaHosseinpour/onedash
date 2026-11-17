-- Phase 4C.0.3 final audit remediation: structured cleanup, explicit gate
-- transitions, direct-insert and lease-RPC fail-closed behavior, global/public
-- default ACL scopes, EXISTS activation checks, and internal-role revocations.
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
-- Clean baseline and fixtures
-- ============================================================

update public.monitor_execution_settings
set execution_enabled = false,
    mode = 'disabled',
    reason = 'phase4c03 setup',
    egress_verified_at = null,
    egress_verified_by = null
where singleton;

select public.onedash_dead_letter_all_jobs('blocked_target');

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
    ('4c030000-0000-4000-8000-000000000001'::uuid,
     'Phase 4C.0.3 transition A',
     'https://4c03-transition-a.acme.test/health'),
    ('4c030000-0000-4000-8000-000000000002'::uuid,
     'Phase 4C.0.3 transition B',
     'https://4c03-transition-b.acme.test/health')
) as v(id, name, url)
join public.organizations o on o.slug = 'acme-monitoring';

insert into public.monitor_execution_allowlist (
  monitor_id, organization_id, url, reason
)
select id, organization_id, url, 'phase4c03 transition test'
from public.monitors
where id::text like '4c030000-0000-4000-8000-%';

-- ============================================================
-- F4: direct pending/leased inserts require enabled fixtures mode
-- ============================================================

select throws_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-direct-pending-disabled', 'pending'
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000001'
  $$,
  '55000',
  null,
  'a direct pending insert is rejected while the gate is disabled'
);

select throws_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status, lease_owner, lease_token, lease_expires_at
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-direct-leased-disabled', 'leased',
           'forged-worker', gen_random_uuid(), now() + interval '5 minutes'
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000001'
  $$,
  '55000',
  null,
  'a direct leased insert is rejected while the gate is disabled'
);

select lives_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status, completed_at, completion_token
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-terminal-disabled', 'completed', now(), gen_random_uuid()
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000001'
  $$,
  'a terminal history insert is still allowed while the gate is disabled'
);

-- Simulate the documented missing-row state without using it as a supported
-- operator path: disable the guard trigger for this transaction, delete the
-- row, then restore the guard and a disabled row.
alter table public.monitor_execution_settings
  disable trigger monitor_execution_settings_guard_write;
delete from public.monitor_execution_settings where singleton;
alter table public.monitor_execution_settings
  enable trigger monitor_execution_settings_guard_write;

select throws_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-direct-pending-missing-gate', 'pending'
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000001'
  $$,
  '55000',
  null,
  'a direct pending insert is rejected while the gate row is missing'
);

select lives_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status, completed_at, completion_token
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-terminal-missing-gate', 'completed', now(), gen_random_uuid()
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000001'
  $$,
  'a terminal history insert is still allowed while the gate row is missing'
);

select lives_ok(
  $$
    insert into public.monitor_execution_settings (
      singleton, execution_enabled, mode, reason
    )
    values (true, false, 'disabled', 'phase4c03 restored disabled')
  $$,
  'the missing gate row can be recreated in disabled mode'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'a recreated gate starts with cleanup required'
);

-- ============================================================
-- F2: explicit mode transitions and fail-closed activation
-- ============================================================

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'customer',
        execution_enabled = true,
        reason = 'phase4c03 customer activation',
        egress_verified_at = now(),
        egress_verified_by = 'phase4c03 test'
    where singleton
  $$,
  'disabled mode can enter customer mode only with an empty nonterminal queue'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'enabled customer mode keeps the cleanup marker open because customer execution is unsupported'
);

select throws_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-direct-pending-customer', 'pending'
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000001'
  $$,
  '55000',
  null,
  'a direct pending insert is rejected in enabled customer mode'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c03 customer to fixtures'
    where singleton
  $$,
  'customer mode can return to fixtures mode only with an empty nonterminal queue'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  false,
  'a safe customer-to-fixtures transition closes the cleanup epoch'
);

select lives_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-fixtures-pending-a', 'pending'
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000001'
  $$,
  'a direct pending insert is accepted in enabled fixtures mode'
);

select throws_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'customer',
        execution_enabled = true,
        reason = 'phase4c03 premature customer',
        egress_verified_at = now(),
        egress_verified_by = 'phase4c03 test'
    where singleton
  $$,
  '23514',
  'execution gate cleanup is incomplete: pending or leased jobs remain',
  'fixtures mode cannot enter customer mode while pending work remains'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set reason = 'phase4c03 fixtures metadata update'
    where singleton
  $$,
  'a same-mode fixtures metadata update is allowed with live pending work'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key = '4c03-fixtures-pending-a'
      and status = 'pending'
  ),
  1,
  'same-mode metadata does not revoke pending work'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'disabled',
        execution_enabled = false,
        reason = 'phase4c03 disable with pending work'
    where singleton
  $$,
  'fixtures mode can be disabled while pending work remains'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'leaving fixtures mode opens a cleanup epoch'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key = '4c03-fixtures-pending-a'
      and status = 'pending'
  ),
  1,
  'gate disable does not scan or dead-letter jobs in the gate transaction'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'updated',
  '1',
  'cleanup dead-letters the pending fixture'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'remaining',
  '0',
  'cleanup reports no nonterminal jobs after the batch'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'cleanup_required',
  'false',
  'cleanup closes the epoch only when the structured result says so'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c03 re-enable after cleanup'
    where singleton
  $$,
  'the gate can re-enter fixtures mode after structured cleanup completes'
);

-- Recreate the enabled-customer -> enabled-fixtures bypass condition without
-- using the insert trigger: an old terminal row is moved back to pending while
-- customer mode is enabled. The transition must still fail closed.
select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'disabled',
        execution_enabled = false,
        reason = 'phase4c03 bypass setup disabled'
    where singleton
  $$,
  'the gate can be disabled before the customer bypass fixture'
);

select public.onedash_dead_letter_all_jobs('blocked_target');

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'customer',
        execution_enabled = true,
        reason = 'phase4c03 bypass setup customer',
        egress_verified_at = now(),
        egress_verified_by = 'phase4c03 test'
    where singleton
  $$,
  'the gate can enter customer mode with an empty queue'
);

update public.check_jobs
set status = 'pending',
    completed_at = null,
    completion_token = null,
    dead_letter_at = null
where idempotency_key = '4c03-terminal-disabled';

select throws_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c03 customer bypass'
    where singleton
  $$,
  '23514',
  'execution gate cleanup is incomplete: pending or leased jobs remain',
  'enabled customer mode cannot bypass cleanup by switching to fixtures with pending work'
);

select is(
  (
    select mode
    from public.monitor_execution_settings
    where singleton
  ),
  'customer',
  'the rejected customer-to-fixtures transition leaves the gate in customer mode'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'disabled',
        execution_enabled = false,
        reason = 'phase4c03 bypass cleanup disabled'
    where singleton
  $$,
  'customer mode can be disabled for cleanup'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'leaving customer mode opens a cleanup epoch'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'updated',
  '1',
  'cleanup removes the bypass fixture pending job'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c03 fixtures zero'
    where singleton
  $$,
  'fixtures mode can be entered after the bypass fixture is cleaned'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'customer',
        execution_enabled = true,
        reason = 'phase4c03 fixtures to customer zero',
        egress_verified_at = now(),
        egress_verified_by = 'phase4c03 test'
    where singleton
  $$,
  'fixtures mode can enter customer mode with an empty nonterminal queue'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'entering customer mode keeps the cleanup marker open'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set reason = 'phase4c03 customer metadata update'
    where singleton
  $$,
  'a same-mode customer metadata update is allowed'
);

select is(
  (
    select cleanup_required
    from public.monitor_execution_settings
    where singleton
  ),
  true,
  'a same-mode customer update cannot clear the fail-closed cleanup marker'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'disabled',
        execution_enabled = false,
        reason = 'phase4c03 final cleanup disabled'
    where singleton
  $$,
  'the gate can be disabled after the transition matrix'
);

select public.onedash_dead_letter_all_jobs('blocked_target');

-- ============================================================
-- F4: lease RPCs cannot recreate pending work after revocation
-- ============================================================

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c03 lease RPC setup'
    where singleton
  $$,
  'fixtures mode is enabled for lease RPC coverage'
);

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, attempts, max_attempts,
  lease_owner, lease_token, lease_expires_at
)
select
  organization_id,
  id,
  'test-1',
  now() + (v.ordinality || ' seconds')::interval,
  now() + (v.ordinality || ' seconds')::interval,
  v.key,
  'leased',
  1,
  5,
  'phase4c03-worker',
  v.token,
  case
    when v.key = '4c03-lease-reap' then now() - interval '1 second'
    else now() + interval '5 minutes'
  end
from public.monitors
cross join (
  values
    ('4c03-lease-release', '4c030000-0000-4000-8000-000000000101'::uuid, 1),
    ('4c03-lease-fail', '4c030000-0000-4000-8000-000000000102'::uuid, 2),
    ('4c03-lease-extend', '4c030000-0000-4000-8000-000000000103'::uuid, 3),
    ('4c03-lease-reap', '4c030000-0000-4000-8000-000000000104'::uuid, 4)
) as v(key, token, ordinality)
where id = '4c030000-0000-4000-8000-000000000002';

select throws_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'customer',
        execution_enabled = true,
        reason = 'phase4c03 leased transition probe',
        egress_verified_at = now(),
        egress_verified_by = 'phase4c03 test'
    where singleton
  $$,
  '23514',
  'execution gate cleanup is incomplete: pending or leased jobs remain',
  'leased jobs block entry to customer mode just like pending jobs'
);

update public.monitor_execution_settings
set mode = 'disabled',
    execution_enabled = false,
    reason = 'phase4c03 lease RPC gate disable'
where singleton;

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key like '4c03-lease-%'
      and status = 'leased'
  ),
  4,
  'gate disable leaves leases in place for the lease RPC checks'
);

select is(
  public.onedash_release_job(
    (select id from public.check_jobs where idempotency_key = '4c03-lease-release'),
    '4c030000-0000-4000-8000-000000000199'::uuid
  )->>'reason',
  'lease_mismatch_or_expired',
  'release still rejects a token that does not own the lease'
);

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = '4c03-lease-release'
  ),
  'leased',
  'a wrong-token release does not alter the real lease owner'
);

select is(
  public.onedash_release_job(
    (select id from public.check_jobs where idempotency_key = '4c03-lease-release'),
    (select lease_token from public.check_jobs where idempotency_key = '4c03-lease-release')
  )->>'status',
  'dead_letter',
  'release dead-letters instead of recreating pending work while the gate is disabled'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key = '4c03-lease-release'
      and status = 'pending'
  ),
  0,
  'release creates no pending row after revocation'
);

select is(
  public.onedash_fail_job(
    (select id from public.check_jobs where idempotency_key = '4c03-lease-fail'),
    (select lease_token from public.check_jobs where idempotency_key = '4c03-lease-fail'),
    'worker_error',
    true
  )->>'status',
  'dead_letter',
  'a retryable failure dead-letters instead of retrying while the gate is disabled'
);

select is(
  (
    select count(*)::int
    from public.check_jobs
    where idempotency_key = '4c03-lease-fail'
      and status = 'pending'
  ),
  0,
  'failure creates no pending row after revocation'
);

select is(
  public.onedash_extend_lease(
    (select id from public.check_jobs where idempotency_key = '4c03-lease-extend'),
    (select lease_token from public.check_jobs where idempotency_key = '4c03-lease-extend'),
    60
  )->>'reason',
  'execution_disabled',
  'lease extension is refused while the gate is disabled'
);

select is(
  public.onedash_reap_expired_leases(10)->>'dead_lettered',
  '1',
  'the reaper dead-letters an expired lease instead of requeueing it while the gate is disabled'
);

select is(
  public.onedash_reap_expired_leases(10)->>'recovered',
  '0',
  'the reaper recovers no work while the gate is disabled'
);

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = '4c03-lease-reap'
  ),
  'dead_letter',
  'the expired lease is terminal after reaping during a revocation'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'updated',
  '1',
  'cleanup dead-letters the remaining extended lease'
);

select is(
  public.onedash_dead_letter_all_jobs('blocked_target')->>'cleanup_required',
  'false',
  'the cleanup epoch closes after all lease fixtures are terminal'
);

select lives_ok(
  $$
    update public.monitor_execution_settings
    set mode = 'fixtures',
        execution_enabled = true,
        reason = 'phase4c03 lease RPC re-enable'
    where singleton
  $$,
  'fixtures mode can be re-enabled after lease cleanup'
);

select lives_ok(
  $$
    insert into public.check_jobs (
      organization_id, monitor_id, region, scheduled_for, available_at,
      idempotency_key, status
    )
    select organization_id, id, 'test-1', clock_timestamp(), clock_timestamp(),
           '4c03-after-reenable', 'pending'
    from public.monitors
    where id = '4c030000-0000-4000-8000-000000000002'
  $$,
  'a direct pending insert is allowed after safe cleanup and re-enable'
);

insert into public.check_jobs (
  organization_id, monitor_id, region, scheduled_for, available_at,
  idempotency_key, status, completed_at, completion_token
)
select
  organization_id,
  id,
  'test-1',
  clock_timestamp(),
  clock_timestamp(),
  '4c03-ack-owner',
  'completed',
  now(),
  '4c030000-0000-4000-8000-000000000105'::uuid
from public.monitors
where id = '4c030000-0000-4000-8000-000000000002';

select is(
  public.onedash_acknowledge_job(
    (select id from public.check_jobs where idempotency_key = '4c03-ack-owner'),
    '4c030000-0000-4000-8000-000000000199'::uuid
  )->>'reason',
  'lease_mismatch',
  'acknowledgement still rejects a token that does not own the completion'
);

select is(
  public.onedash_acknowledge_job(
    (select id from public.check_jobs where idempotency_key = '4c03-ack-owner'),
    (select completion_token from public.check_jobs where idempotency_key = '4c03-ack-owner')
  )->>'duplicate',
  'true',
  'acknowledgement still accepts the exact completion owner as a duplicate'
);

-- ============================================================
-- F6: EXISTS activation guard, not COUNT(*)
-- ============================================================

select is(
  position(
    'count(*)' in lower(pg_get_functiondef(
      'public.onedash_execution_gate_change()'::regprocedure
    ))
  ),
  0,
  'the execution-gate activation guard does not use count(*)'
);

select ok(
  position(
    'exists (' in lower(pg_get_functiondef(
      'public.onedash_execution_gate_change()'::regprocedure
    ))
  ) > 0,
  'the execution-gate activation guard uses an EXISTS probe'
);

-- ============================================================
-- F7: internal helper revocation and preserved worker RPC grants
-- ============================================================

select is(
  (
    select count(*)::int
    from unnest(
      array['onedash_scheduler', 'onedash_queue', 'onedash_ingestor']
    ) as r(role_name)
    cross join unnest(
      array[
        'public.onedash_require_supported_region(text)',
        'public.onedash_dead_letter_monitor_jobs(uuid,text)',
        'public.onedash_dead_letter_all_jobs(text)',
        'public.onedash_bind_allowlist_url()',
        'public.onedash_lock_allowlist_monitor()',
        'public.onedash_monitor_authorization_change()',
        'public.onedash_allowlist_revocation()',
        'public.onedash_guard_schedule_write()',
        'public.onedash_guard_check_jobs_insert()',
        'public.onedash_is_fixture_hostname(text)',
        'public.onedash_job_backoff_seconds(integer)',
        'public.onedash_validate_result_payload(jsonb)',
        'public.onedash_validate_heartbeat_details(text,jsonb)',
        'public.onedash_guard_heartbeat_details()',
        'public.onedash_safe_metric_bigint(text,bigint,bigint)'
      ]
    ) as f(signature)
    where has_function_privilege(r.role_name, f.signature, 'EXECUTE')
  ),
  0,
  'no internal helper is executable by the scheduler, queue, or ingestor role'
);

select is(
  has_function_privilege(
    'onedash_scheduler',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  true,
  'scheduler-only heartbeat cleanup remains executable by the scheduler'
);

select is(
  (
    select count(*)::int
    from unnest(array['onedash_queue', 'onedash_ingestor']) as r(role_name)
    where has_function_privilege(
      r.role_name,
      'public.onedash_cleanup_stale_heartbeats(integer)',
      'EXECUTE'
    )
  ),
  0,
  'heartbeat cleanup remains denied to the queue and ingestor roles'
);

select is(
  (
    select count(*)::int
    from (
      values
        ('onedash_scheduler', 'public.onedash_schedule_due_jobs(integer,integer)'),
        ('onedash_scheduler', 'public.onedash_reap_expired_leases(integer)'),
        ('onedash_scheduler', 'public.onedash_record_heartbeat(text,text,text,jsonb)'),
        ('onedash_queue', 'public.onedash_claim_jobs(text,text,integer,integer,text[])'),
        ('onedash_queue', 'public.onedash_extend_lease(uuid,uuid,integer)'),
        ('onedash_queue', 'public.onedash_release_job(uuid,uuid)'),
        ('onedash_queue', 'public.onedash_fail_job(uuid,uuid,text,boolean)'),
        ('onedash_queue', 'public.onedash_acknowledge_job(uuid,uuid)'),
        ('onedash_queue', 'public.onedash_record_heartbeat(text,text,text,jsonb)'),
        ('onedash_ingestor', 'public.onedash_ingest_check_result(uuid,uuid,jsonb)'),
        ('onedash_ingestor', 'public.onedash_acknowledge_job(uuid,uuid)')
    ) as grants(role_name, signature)
    where not has_function_privilege(role_name, signature, 'EXECUTE')
  ),
  0,
  'the intended worker RPC grants are preserved'
);

select is(
  (
    select count(*)::int
    from unnest(
      array['onedash_scheduler', 'onedash_queue', 'onedash_ingestor']
    ) as r(role_name)
    where has_function_privilege(
      r.role_name,
      'public.onedash_execution_status()',
      'EXECUTE'
    )
  ),
  3,
  'all three worker groups retain the execution-status surface'
);

-- ============================================================
-- F3: global and public-schema default ACL scopes
-- ============================================================

select is(
  (
    select count(*)::int
    from pg_default_acl d
    join pg_roles owner on owner.oid = d.defaclrole
    cross join lateral pg_catalog.aclexplode(d.defaclacl) as acl
    left join pg_roles grantee on grantee.oid = acl.grantee
    where owner.rolname in ('postgres', 'onedash_function_owner')
      and d.defaclobjtype = 'f'
      and d.defaclnamespace = 0
      and acl.privilege_type = 'EXECUTE'
      and (
        acl.grantee = 0
        or grantee.rolname in ('anon', 'authenticated', 'service_role')
      )
  ),
  0,
  'global default function ACLs for postgres and the function owner grant no PUBLIC or API role execute'
);

select is(
  (
    select count(*)::int
    from pg_default_acl d
    join pg_roles owner on owner.oid = d.defaclrole
    cross join lateral pg_catalog.aclexplode(d.defaclacl) as acl
    left join pg_roles grantee on grantee.oid = acl.grantee
    where owner.rolname in ('postgres', 'onedash_function_owner')
      and d.defaclobjtype = 'f'
      and d.defaclnamespace = 'public'::regnamespace
      and acl.privilege_type = 'EXECUTE'
      and (
        acl.grantee = 0
        or grantee.rolname in ('anon', 'authenticated', 'service_role')
      )
  ),
  0,
  'public-schema default function ACLs for postgres and the function owner grant no PUBLIC or API role execute'
);

create function public.onedash_test_4c03_postgres_default_acl()
returns integer
language sql
as $$ select 1 $$;

select is(
  (
    select count(*)::int
    from pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) as acl
    where p.oid =
      'public.onedash_test_4c03_postgres_default_acl()'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'a new postgres-owned function has no PUBLIC execute entry'
);

select is(
  (
    select count(*)::int
    from unnest(
      array['anon', 'authenticated', 'service_role']
    ) as r(role_name)
    where has_function_privilege(
      r.role_name,
      'public.onedash_test_4c03_postgres_default_acl()',
      'EXECUTE'
    )
  ),
  0,
  'a new postgres-owned function denies anon, authenticated, and service_role'
);

drop function public.onedash_test_4c03_postgres_default_acl();

set local role onedash_function_owner;

create function public.onedash_test_4c03_owner_default_acl()
returns integer
language sql
as $$ select 1 $$;

reset role;

select is(
  (
    select pg_get_userbyid(p.proowner)
    from pg_proc p
    where p.oid =
      'public.onedash_test_4c03_owner_default_acl()'::regprocedure
  ),
  'onedash_function_owner',
  'the function-owner probe is owned by the function owner'
);

select is(
  (
    select count(*)::int
    from pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) as acl
    where p.oid =
      'public.onedash_test_4c03_owner_default_acl()'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'a new function-owner function has no PUBLIC execute entry'
);

select is(
  (
    select count(*)::int
    from unnest(
      array['anon', 'authenticated', 'service_role']
    ) as r(role_name)
    where has_function_privilege(
      r.role_name,
      'public.onedash_test_4c03_owner_default_acl()',
      'EXECUTE'
    )
  ),
  0,
  'a new function-owner function denies anon, authenticated, and service_role'
);

drop function public.onedash_test_4c03_owner_default_acl();

select is(
  has_function_privilege('anon', 'public.waitlist_count()', 'EXECUTE'),
  true,
  'anon still has the legitimate aggregate waitlist RPC grant'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.ensure_my_account()',
    'EXECUTE'
  ),
  true,
  'authenticated still has the legitimate account bootstrap grant'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.is_org_member(uuid)',
    'EXECUTE'
  ),
  true,
  'authenticated still has the legitimate organization RLS helper grant'
);

select is(
  has_function_privilege(
    'anon',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  false,
  'anon still cannot execute heartbeat cleanup'
);

select * from finish();
rollback;
