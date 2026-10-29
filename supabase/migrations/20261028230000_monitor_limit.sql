-- ============================================================
-- Concurrency-safe development limit for monitors per organization
-- ============================================================
-- Phase 3 has no plan entitlements or billing. A single documented development
-- limit protects the local/demo database until plan limits exist. The limit is
-- enforced in the database, not only in the UI, so direct PostgREST inserts and
-- concurrent server actions cannot bypass it.
--
-- The value lives in a singleton table with RLS enabled and no policies or
-- grants for anon/authenticated. It is intentionally NOT a session GUC:
-- PostgreSQL lets any role SET a custom GUC in its own session, which would let
-- an authenticated user raise the limit before a direct insert.
--
-- Change the limit as a database operator:
--   update public.monitor_limit_settings set limit_per_org = 50;
-- The fallback/default is 25.
--
-- The trigger takes a transaction-scoped advisory lock keyed by organization,
-- then counts rows in the same transaction. Concurrent inserts for one tenant
-- serialize, so two requests cannot both observe "one slot left" and insert.
-- ============================================================

create table if not exists public.monitor_limit_settings (
  singleton    boolean primary key default true,
  limit_per_org integer not null default 25,
  updated_at   timestamptz not null default now(),
  constraint monitor_limit_settings_singleton_check check (singleton),
  constraint monitor_limit_settings_value_check check (
    limit_per_org between 1 and 10000
  )
);

insert into public.monitor_limit_settings (singleton, limit_per_org)
values (true, 25)
on conflict (singleton) do nothing;

alter table public.monitor_limit_settings enable row level security;

-- No policies are created. RLS therefore denies every anon/authenticated row.
-- The security-definer function below reads the table as its owner.
revoke all on table public.monitor_limit_settings from public;
revoke all on table public.monitor_limit_settings from anon;
revoke all on table public.monitor_limit_settings from authenticated;

drop trigger if exists monitor_limit_settings_set_updated_at
  on public.monitor_limit_settings;
create trigger monitor_limit_settings_set_updated_at
  before update on public.monitor_limit_settings
  for each row execute function public.set_updated_at();

comment on table public.monitor_limit_settings is
  'Operator-managed development monitor limit. RLS is enabled with no anon/authenticated policies or grants; read through public.monitor_limit_per_org().';

create or replace function public.monitor_limit_per_org()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select s.limit_per_org
      from public.monitor_limit_settings s
      where s.singleton
    ),
    25
  );
$$;

comment on function public.monitor_limit_per_org() is
  'Returns the documented development monitor limit per organization from the protected settings table. Fallback 25.';

revoke all on function public.monitor_limit_per_org() from public;
grant execute on function public.monitor_limit_per_org() to authenticated;

create or replace function public.enforce_monitor_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := public.monitor_limit_per_org();
  v_count integer;
begin
  -- Serialize limit checks for one organization for the rest of this
  -- transaction. The row count below and the caller's INSERT see the same
  -- snapshot, so concurrent requests cannot both take the last slot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'onedash-monitor-limit:' || new.organization_id::text,
      0
    )
  );

  select count(*)
  into v_count
  from public.monitors m
  where m.organization_id = new.organization_id;

  if v_count >= v_limit then
    raise exception 'Monitor limit reached for this organization (%).', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.enforce_monitor_limit() is
  'BEFORE INSERT trigger function. Serializes per-organization inserts and rejects rows over the development limit.';

revoke all on function public.enforce_monitor_limit() from public;

drop trigger if exists monitors_enforce_limit on public.monitors;
create trigger monitors_enforce_limit
  before insert on public.monitors
  for each row execute function public.enforce_monitor_limit();

comment on table public.monitors is
  'Monitor configuration. RLS: members read; owner/admin/member write. A BEFORE INSERT trigger enforces the documented per-organization development limit. Encrypted headers/bodies live only in monitor_request_secrets.';
