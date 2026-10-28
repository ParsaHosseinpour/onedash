-- Schema, constraint, index, and privilege invariants.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select no_plan();

-- Every private table must have RLS enabled.
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in (
        'profiles',
        'organizations',
        'organization_members',
        'monitors',
        'monitor_schedules',
        'monitor_state',
        'check_results',
        'incidents',
        'incident_updates',
        'alert_channels',
        'alert_channel_secrets',
        'monitor_alert_channels',
        'alert_deliveries',
        'status_pages',
        'status_page_monitors',
        'audit_logs',
        'monitor_request_secrets',
        'waitlist'
      )
      and not c.relrowsecurity
  ),
  0,
  'all private tables have row level security enabled'
);

select is(
  (select relrowsecurity from pg_class where oid = 'public.waitlist'::regclass),
  true,
  'waitlist has RLS enabled'
);

select is(
  (
    select count(*)::int
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
  ),
  0,
  'anon and authenticated have no non-DML default table privileges'
);

select is(
  (
    select count(*)::int
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'check_results'
      and indexname = 'check_results_monitor_idempotency_key'
  ),
  1,
  'check-result idempotency key has a unique index'
);

select is(
  (
    select count(*)::int
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'incidents'
      and indexname = 'incidents_one_open_per_monitor_idx'
  ),
  1,
  'one-open-incident partial unique index exists'
);

select ok(
  (
    select indexdef like '%WHERE (resolved_at IS NULL)%'
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'incidents'
      and indexname = 'incidents_one_open_per_monitor_idx'
  ),
  'open-incident index is partial on unresolved incidents'
);

select is(
  (
    select count(*)::int
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'monitor_schedules'
      and indexname = 'monitor_schedules_due_idx'
  ),
  1,
  'due-schedule index exists'
);

select is(
  (
    select count(*)::int
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'monitors'
      and indexname = 'monitors_active_org_idx'
  ),
  1,
  'active-monitor tenant index exists'
);

select is(
  (
    select count(*)::int
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'check_results'
      and indexname = 'check_results_monitor_checked_idx'
  ),
  1,
  'recent check-history index exists'
);

select is(
  (
    select count(*)::int
    from pg_constraint
    where conname = 'check_results_error_consistency_check'
  ),
  1,
  'check-result error/status consistency constraint exists'
);

select is(
  (
    select count(*)::int
    from pg_constraint
    where conname = 'alert_channels_config_check'
  ),
  1,
  'alert-channel non-secret config constraint exists'
);

select is(
  (
    select count(*)::int
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'check_results'
      and column_name in ('response_body', 'body', 'response_headers')
  ),
  0,
  'check_results has no response body or header columns'
);

select is(
  (
    select count(*)::int
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_status_pages'
      and column_name in ('id', 'organization_id', 'created_by', 'is_published')
  ),
  0,
  'public status-page view exposes no internal IDs or flags'
);

select is(
  (
    select count(*)::int
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_status_page_monitors'
      and column_name in ('monitor_id', 'organization_id', 'url', 'status_page_id')
  ),
  0,
  'public monitor view exposes no internal IDs or URLs'
);

-- SECURITY DEFINER functions in public must pin search_path.
select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not ('search_path=""' = any (coalesce(p.proconfig, '{}'::text[])))
  ),
  0,
  'all SECURITY DEFINER functions in public pin an empty search_path'
);

select is(
  (
    select rolcanlogin
    from pg_roles
    where rolname = 'onedash_worker'
  ),
  false,
  'worker group role exists and cannot log in directly'
);

select is(
  has_table_privilege('anon', 'public.waitlist', 'SELECT'),
  false,
  'anon cannot select waitlist rows'
);

select is(
  has_table_privilege('anon', 'public.waitlist', 'INSERT'),
  false,
  'anon cannot insert waitlist rows directly'
);

select is(
  has_table_privilege('authenticated', 'public.waitlist', 'INSERT'),
  false,
  'authenticated cannot insert waitlist rows directly'
);

select is(
  has_table_privilege('service_role', 'public.waitlist', 'INSERT'),
  true,
  'service_role can insert waitlist rows through the trusted server path'
);

select is(
  (
    select prosecdef
    from pg_proc
    where oid = 'public.waitlist_count()'::regprocedure
  ),
  true,
  'waitlist_count is SECURITY DEFINER'
);

select is(
  (
    select proconfig
    from pg_proc
    where oid = 'public.waitlist_count()'::regprocedure
  ),
  array['search_path=""']::text[],
  'waitlist_count pins an empty search_path'
);

select hasnt_column(
  'public',
  'alert_channels',
  'secret',
  'alert_channels has no inline secret column'
);

select hasnt_column(
  'public',
  'monitors',
  'request_headers',
  'monitors has no inline request-header column'
);

select is(
  has_table_privilege('anon', 'public.public_status_pages', 'SELECT'),
  true,
  'anon can read the published status-page view'
);

select is(
  has_table_privilege('anon', 'public.public_status_page_monitors', 'SELECT'),
  true,
  'anon can read the published monitor view'
);

select * from finish();
rollback;
