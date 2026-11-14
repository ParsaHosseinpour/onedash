-- Phase 4C.0.1 audit remediation: complete SECURITY DEFINER ACL matrix,
-- direct-grant detection, allowlist monitor immutability, and function-owner
-- default-ACL checks.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select no_plan();

-- ============================================================
-- Complete application SECURITY DEFINER inventory
-- ============================================================
-- Every application-owned SECURITY DEFINER function and its intended effective
-- EXECUTE matrix. The matrix is deliberately explicit: a new function must be
-- added here, and a privilege regression in any cell fails a test.
--
-- Columns: signature, anon, authenticated, service_role, scheduler, queue,
-- ingestor. PUBLIC must never appear for any row (asserted separately).

create temporary table onedash_4c01_expected_acl (
  signature text primary key,
  anon_ok boolean not null,
  authenticated_ok boolean not null,
  service_role_ok boolean not null,
  scheduler_ok boolean not null,
  queue_ok boolean not null,
  ingestor_ok boolean not null
) on commit drop;

insert into onedash_4c01_expected_acl values
  -- Public/authenticated RPC exceptions.
  ('public.waitlist_count()', true, true, false, false, false, false),
  ('public.is_org_member(uuid)', false, true, false, false, false, false),
  ('public.has_org_role(uuid,public.organization_role[])', false, true, false, false, false, false),
  ('public.can_manage_org(uuid)', false, true, false, false, false, false),
  ('public.can_write_org(uuid)', false, true, false, false, false, false),
  ('public.is_org_owner(uuid)', false, true, false, false, false, false),
  ('public.ensure_user_account(uuid)', false, false, false, false, false, false),
  ('public.ensure_my_account()', false, true, false, false, false, false),
  ('public.handle_new_auth_user()', false, false, false, false, false, false),
  ('public.handle_auth_user_email_change()', false, false, false, false, false, false),
  ('public.enforce_last_org_owner()', false, false, false, false, false, false),
  ('public.validate_monitor_state_incident()', false, false, false, false, false, false),
  ('public.audit_configuration_change()', false, false, false, false, false, false),
  ('public.monitor_limit_per_org()', false, true, false, false, false, false),
  ('public.enforce_monitor_limit()', false, false, false, false, false, false),
  -- Internal worker RPCs.
  ('public.onedash_execution_status()', false, false, false, true, true, true),
  ('public.onedash_schedule_due_jobs(integer,integer)', false, false, false, true, false, false),
  ('public.onedash_claim_jobs(text,text,integer,integer,text[])', false, false, false, false, true, false),
  ('public.onedash_extend_lease(uuid,uuid,integer)', false, false, false, false, true, false),
  ('public.onedash_release_job(uuid,uuid)', false, false, false, false, true, false),
  ('public.onedash_fail_job(uuid,uuid,text,boolean)', false, false, false, false, true, false),
  ('public.onedash_reap_expired_leases(integer)', false, false, false, true, true, false),
  ('public.onedash_acknowledge_job(uuid,uuid)', false, false, false, false, true, true),
  ('public.onedash_ingest_check_result(uuid,uuid,jsonb)', false, false, false, false, false, true),
  ('public.onedash_record_heartbeat(text,text,text,jsonb)', false, false, false, true, true, false),
  ('public.onedash_queue_metrics()', false, false, false, true, true, true),
  ('public.onedash_require_supported_region(text)', false, false, false, false, false, false),
  ('public.onedash_dead_letter_monitor_jobs(uuid,text)', false, false, false, false, false, false),
  ('public.onedash_dead_letter_all_jobs(text)', false, false, false, false, false, false),
  ('public.onedash_execution_gate_change()', false, false, false, false, false, false),
  ('public.onedash_lock_allowlist_monitor()', false, false, false, false, false, false),
  ('public.onedash_bind_allowlist_url()', false, false, false, false, false, false),
  ('public.onedash_monitor_authorization_change()', false, false, false, false, false, false),
  ('public.onedash_allowlist_revocation()', false, false, false, false, false, false),
  ('public.onedash_cleanup_stale_heartbeats(integer)', false, false, false, true, false, false);

select is(
  (select count(*)::int from onedash_4c01_expected_acl),
  35,
  'the inventory contains all 35 application SECURITY DEFINER functions'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where p.prosecdef
  ),
  35,
  'every inventory signature resolves to a SECURITY DEFINER function'
);

select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and pg_get_userbyid(p.proowner) in (
        'postgres',
        'onedash_function_owner'
      )
  ),
  35,
  'the database contains exactly the 35 inventoried application SECURITY DEFINER functions'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where pg_get_userbyid(p.proowner) not in (
      'postgres',
      'onedash_function_owner'
    )
  ),
  0,
  'every application SECURITY DEFINER function is owned by an administrable application role'
);

-- Effective privilege matrix. has_function_privilege catches inherited and
-- PUBLIC-derived access, not just direct ACL entries.
select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where has_function_privilege('anon', p.oid, 'EXECUTE')
          is distinct from e.anon_ok
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          is distinct from e.authenticated_ok
       or has_function_privilege('service_role', p.oid, 'EXECUTE')
          is distinct from e.service_role_ok
       or has_function_privilege('onedash_scheduler', p.oid, 'EXECUTE')
          is distinct from e.scheduler_ok
       or has_function_privilege('onedash_queue', p.oid, 'EXECUTE')
          is distinct from e.queue_ok
       or has_function_privilege('onedash_ingestor', p.oid, 'EXECUTE')
          is distinct from e.ingestor_ok
  ),
  0,
  'the effective EXECUTE matrix matches the intended matrix for every SECURITY DEFINER function'
);

-- Direct ACL entries are checked separately. This is the D-1 regression: a
-- REVOKE from PUBLIC alone would leave a direct anon/authenticated/service_role
-- grant in place while the effective matrix above still looked safe in some
-- roles. Here an unexpected grantee is a failure even if another rule masks it.
select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) as acl
    join pg_roles r on r.oid = acl.grantee
    where acl.privilege_type = 'EXECUTE'
      and (
        (r.rolname = 'anon' and not e.anon_ok)
        or (r.rolname = 'authenticated' and not e.authenticated_ok)
        or (r.rolname = 'service_role' and not e.service_role_ok)
        or (r.rolname = 'onedash_scheduler' and not e.scheduler_ok)
        or (r.rolname = 'onedash_queue' and not e.queue_ok)
        or (r.rolname = 'onedash_ingestor' and not e.ingestor_ok)
      )
  ),
  0,
  'no SECURITY DEFINER function has an unexpected direct EXECUTE grant'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) as acl
    where acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'PUBLIC has no direct or default-derived EXECUTE entry on any SECURITY DEFINER function'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where has_function_privilege('onedash_worker', p.oid, 'EXECUTE')
  ),
  0,
  'the deprecated onedash_worker role cannot execute any SECURITY DEFINER function'
);

-- Explicit worker matrix checks, so a regression names the intended group.
select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where has_function_privilege('onedash_scheduler', p.oid, 'EXECUTE')
      and not e.scheduler_ok
  ),
  0,
  'the scheduler has no unintended SECURITY DEFINER execution grant'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where has_function_privilege('onedash_queue', p.oid, 'EXECUTE')
      and not e.queue_ok
  ),
  0,
  'the queue role has no unintended SECURITY DEFINER execution grant'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where has_function_privilege('onedash_ingestor', p.oid, 'EXECUTE')
      and not e.ingestor_ok
  ),
  0,
  'the ingestor has no unintended SECURITY DEFINER execution grant'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where e.scheduler_ok
      and not has_function_privilege('onedash_scheduler', p.oid, 'EXECUTE')
  ),
  0,
  'every intended scheduler SECURITY DEFINER grant is preserved'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where e.queue_ok
      and not has_function_privilege('onedash_queue', p.oid, 'EXECUTE')
  ),
  0,
  'every intended queue SECURITY DEFINER grant is preserved'
);

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where e.ingestor_ok
      and not has_function_privilege('onedash_ingestor', p.oid, 'EXECUTE')
  ),
  0,
  'every intended ingestor SECURITY DEFINER grant is preserved'
);

-- Cleanup is explicitly scheduler-only and must not follow the Phase 4B queue
-- grant that was removed in Phase 4C.0.
select is(
  has_function_privilege(
    'onedash_scheduler',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  true,
  'heartbeat cleanup remains executable by the scheduler'
);
select is(
  has_function_privilege(
    'onedash_queue',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  false,
  'heartbeat cleanup remains denied to the queue role'
);
select is(
  has_function_privilege(
    'onedash_ingestor',
    'public.onedash_cleanup_stale_heartbeats(integer)',
    'EXECUTE'
  ),
  false,
  'heartbeat cleanup remains denied to the ingestor role'
);

-- ============================================================
-- No unintended function-owner privilege expansion
-- ============================================================

select is(
  (
    select count(*)::int
    from pg_default_acl d
    join pg_roles owner on owner.oid = d.defaclrole
    cross join lateral pg_catalog.aclexplode(d.defaclacl) as acl
    left join pg_roles grantee on grantee.oid = acl.grantee
    where owner.rolname = 'onedash_function_owner'
      and d.defaclobjtype = 'f'
      and acl.privilege_type = 'EXECUTE'
      and (
        acl.grantee = 0
        or grantee.rolname in ('anon', 'authenticated', 'service_role')
      )
  ),
  0,
  'the function owner default ACL grants no PUBLIC or API-role function execute'
);

select is(
  (
    select count(*)::int
    from pg_roles r
    where r.rolname = 'onedash_function_owner'
      and (
        r.rolsuper
        or r.rolcanlogin
        or r.rolcreaterole
        or r.rolcreatedb
        or r.rolbypassrls
      )
  ),
  0,
  'the function owner remains NOLOGIN, non-superuser, and has no elevated attributes'
);

select is(
  (
    select count(*)::int
    from pg_auth_members m
    join pg_roles role on role.oid = m.roleid
    join pg_roles member on member.oid = m.member
    where role.rolname = 'onedash_function_owner'
      and member.rolname in (
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

-- ============================================================
-- Finding A-2: allowlist monitor_id immutability
-- ============================================================

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
    ('4c010000-0000-4000-8000-000000000001'::uuid,
     'Phase 4C.0.1 allowlist A',
     'https://4c01-allowlist-a.acme.test/health'),
    ('4c010000-0000-4000-8000-000000000002'::uuid,
     'Phase 4C.0.1 allowlist B',
     'https://4c01-allowlist-b.acme.test/health')
) as v(id, name, url)
join public.organizations o on o.slug = 'acme-monitoring';

insert into public.monitor_execution_allowlist (
  monitor_id, organization_id, url, reason
)
select id, organization_id, url, 'phase4c01 immutability test'
from public.monitors
where id = '4c010000-0000-4000-8000-000000000001';

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
  '4c01-immutable-a-job',
  'pending'
from public.monitors
where id = '4c010000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    update public.monitor_execution_allowlist
    set monitor_id = '4c010000-0000-4000-8000-000000000002',
        url = 'https://4c01-allowlist-b.acme.test/health'
    where monitor_id = '4c010000-0000-4000-8000-000000000001'
  $$,
  '23514',
  null,
  'moving an allowlist row from monitor A to monitor B is rejected'
);

select is(
  (
    select count(*)::int
    from public.monitor_execution_allowlist
    where monitor_id = '4c010000-0000-4000-8000-000000000001'
  ),
  1,
  'the rejected movement leaves monitor A authorization intact'
);

select is(
  (
    select count(*)::int
    from public.monitor_execution_allowlist
    where monitor_id = '4c010000-0000-4000-8000-000000000002'
  ),
  0,
  'the rejected movement creates no monitor B authorization'
);

select is(
  (
    select status::text
    from public.check_jobs
    where idempotency_key = '4c01-immutable-a-job'
  ),
  'pending',
  'the rejected movement does not revoke or alter monitor A jobs'
);

select lives_ok(
  $$
    update public.monitor_execution_allowlist
    set reason = 'legitimate reason update'
    where monitor_id = '4c010000-0000-4000-8000-000000000001'
  $$,
  'a legitimate reason update on the same monitor is still allowed'
);

select lives_ok(
  $$
    update public.monitor_execution_allowlist
    set url = (
      select m.url
      from public.monitors m
      where m.id = '4c010000-0000-4000-8000-000000000001'
    ),
        reason = 'legitimate same-monitor URL refresh'
    where monitor_id = '4c010000-0000-4000-8000-000000000001'
  $$,
  'a legitimate same-monitor URL refresh is still allowed'
);

-- ============================================================
-- D-2 status (external blocker; not claimed as fixed)
-- ============================================================

select is(
  (
    select count(*)::int
    from onedash_4c01_expected_acl e
    join pg_proc p on p.oid = to_regprocedure(e.signature)
    where pg_get_userbyid(p.proowner) = 'supabase_admin'
  ),
  0,
  'no application SECURITY DEFINER function is owned by supabase_admin in this local database'
);

select diag(
  'D-2 is an external production blocker. The local postgres migration role is not a superuser and is not a member of supabase_admin, so it cannot change supabase_admin defaults. Run docs/runbooks/supabase-admin-function-acl.md as supabase_admin or a superuser and verify on the hosted project. This test does not claim that the hosted default ACL is fixed.'
);

select ok(
  true,
  'the supabase_admin limitation is reported instead of being marked fixed'
);

select * from finish();
rollback;
