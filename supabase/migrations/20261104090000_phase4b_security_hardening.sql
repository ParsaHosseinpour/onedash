-- ============================================================
-- Phase 4B security hardening
-- ============================================================
-- Forward-only hardening for the scheduler/queue/ingestion foundation. This
-- migration does NOT enable customer monitoring. The execution gate remains
-- disabled by default and customer mode is still refused by both components.
--
-- Permission redesign:
--   * Every Phase 4B SECURITY DEFINER function is owned by the dedicated
--     NOLOGIN role onedash_function_owner instead of the postgres superuser.
--     That role has only the table privileges and permissive RLS policies the
--     functions actually need. It cannot log in and no login role is a member.
--   * EXECUTE on newly created public functions is no longer granted to PUBLIC
--     by default. The Phase 4B functions explicitly grant EXECUTE only to the
--     scheduler, queue, and ingestor group roles.
--   * service_role keeps normal DML but loses TRUNCATE, REFERENCES, TRIGGER,
--     and (PostgreSQL 17+) MAINTAIN on the internal Phase 4B tables.
-- ============================================================

-- ------------------------------------------------------------
-- Dedicated function-owner role and default privileges
-- ------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'onedash_function_owner') then
    execute 'create role onedash_function_owner nologin noinherit';
  end if;
end $$;

comment on role onedash_function_owner is
  'Phase 4B function owner. NOLOGIN. Owns only the restricted SECURITY DEFINER functions and has no application table grants outside those functions. The postgres bootstrap role is a member solely to transfer function ownership; no application role is a member.';

-- The migration role (postgres) must be able to SET ROLE to the owner in
-- order to transfer function ownership. This is bootstrap administration, not
-- application access: postgres is not used by any Phase 4B service and the
-- owner role itself cannot log in.
grant onedash_function_owner to postgres;

grant usage, create on schema public to onedash_function_owner;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function by default. Remove
-- that default for objects created by the migration role so a future SECURITY
-- DEFINER helper cannot become callable by anon or authenticated merely because
-- it was created in schema public. A schema-qualified ALTER DEFAULT PRIVILEGES
-- does not affect functions on this PostgreSQL version, so the database-wide
-- form is intentional.
alter default privileges for role postgres
  revoke execute on functions from public;

-- ------------------------------------------------------------
-- Bounded region registry
-- ------------------------------------------------------------

create table public.supported_regions (
  region     text primary key,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  constraint supported_regions_region_check check (
    char_length(region) between 2 and 32
    and region ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  )
);

insert into public.supported_regions (region)
values
  ('global'),
  ('local-1'),
  ('us-east'),
  ('us-west'),
  ('eu-west'),
  ('ap-south'),
  ('test-1'),
  ('test-2')
on conflict (region) do nothing;

alter table public.supported_regions enable row level security;

revoke all on table public.supported_regions from public, anon, authenticated;
revoke all on table public.supported_regions from service_role;

comment on table public.supported_regions is
  'Bounded operator-managed region registry. Scheduling, jobs, results, and heartbeats may only use enabled rows. No application role can read or mutate it directly.';

-- ------------------------------------------------------------
-- Bind the fixture allowlist to the exact monitor URL
-- ------------------------------------------------------------
-- A hostname-only allowlist would survive a monitor URL edit. The URL column
-- makes the authorization decision explicit; the monitor update trigger below
-- deletes the row whenever the URL changes, so authorization is revoked rather
-- than silently inherited by the new destination.

alter table public.monitor_execution_allowlist
  add column if not exists url text;

-- Remove orphaned authorization rows first; otherwise the URL backfill below
-- would leave nulls and the subsequent NOT NULL constraint would fail.
delete from public.monitor_execution_allowlist a
where not exists (
  select 1
  from public.monitors m
  where m.id = a.monitor_id
    and m.organization_id = a.organization_id
);

update public.monitor_execution_allowlist a
set url = m.url
from public.monitors m
where m.id = a.monitor_id
  and m.organization_id = a.organization_id
  and a.url is null;

alter table public.monitor_execution_allowlist
  alter column url set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'monitor_execution_allowlist_url_check'
  ) then
    alter table public.monitor_execution_allowlist
      add constraint monitor_execution_allowlist_url_check check (
        char_length(url) between 8 and 2048
        and url ~* '^https?://[^[:space:]]+$'
        and url !~* '^[a-z]+://[^/]*@'
      );
  end if;
end $$;

-- ------------------------------------------------------------
-- Completion ownership token
-- ------------------------------------------------------------
-- The lease token is cleared on completion. Keeping a separate completion
-- token lets duplicate ingestion/acknowledgement prove it is the same worker
-- that produced the result instead of accepting any caller that knows the job
-- UUID.

alter table public.check_jobs
  add column if not exists completion_token uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'check_jobs_completion_token_check'
  ) then
    alter table public.check_jobs
      add constraint check_jobs_completion_token_check check (
        completion_token is null or status = 'completed'
      );
  end if;
end $$;

-- ------------------------------------------------------------
-- Bounded regions on data-plane rows
-- ------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'monitor_schedules_region_fk'
  ) then
    alter table public.monitor_schedules
      add constraint monitor_schedules_region_fk
      foreign key (region) references public.supported_regions (region)
      on update cascade on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'check_jobs_region_fk'
  ) then
    alter table public.check_jobs
      add constraint check_jobs_region_fk
      foreign key (region) references public.supported_regions (region)
      on update cascade on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'check_results_region_fk'
  ) then
    alter table public.check_results
      add constraint check_results_region_fk
      foreign key (region) references public.supported_regions (region)
      on update cascade on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'service_heartbeats_region_fk'
  ) then
    alter table public.service_heartbeats
      add constraint service_heartbeats_region_fk
      foreign key (region) references public.supported_regions (region)
      on update cascade on delete restrict;
  end if;
end $$;

-- ------------------------------------------------------------
-- Internal helpers and guards
-- ------------------------------------------------------------

create or replace function public.onedash_is_fixture_hostname(p_host text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_host is not null
    and char_length(p_host) between 6 and 253
    and p_host = pg_catalog.lower(p_host)
    and p_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
    and p_host like '%.test'
    and p_host <> 'localhost'
    and p_host not like '%.localhost'
    and p_host !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$';
$$;

comment on function public.onedash_is_fixture_hostname(text) is
  'True only for a lower-case DNS hostname ending in .test that is not localhost or an IPv4 literal.';

revoke all on function public.onedash_is_fixture_hostname(text) from public;

create or replace function public.onedash_require_supported_region(p_region text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_region is null
     or not exists (
       select 1
       from public.supported_regions r
       where r.region = p_region
         and r.enabled
     ) then
    raise exception 'unsupported region' using errcode = '22023';
  end if;
end;
$$;

comment on function public.onedash_require_supported_region(text) is
  'Raises 22023 unless the region exists and is enabled in supported_regions.';

revoke all on function public.onedash_require_supported_region(text) from public;

create or replace function public.onedash_dead_letter_monitor_jobs(
  p_monitor_id uuid,
  p_error_class text default 'blocked_target'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_updated integer;
begin
  if p_monitor_id is null then
    return 0;
  end if;
  if p_error_class is null
     or p_error_class not in ('blocked_target', 'worker_shutdown') then
    raise exception 'unsupported dead-letter error class' using errcode = '22023';
  end if;

  update public.check_jobs
  set status = 'dead_letter',
      dead_letter_at = v_now,
      completed_at = null,
      completion_token = null,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_class = p_error_class,
      last_failure_at = v_now,
      updated_at = v_now
  where monitor_id = p_monitor_id
    and status = 'pending';

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.onedash_dead_letter_monitor_jobs(uuid, text) is
  'Terminally fails pending jobs when authorization for a monitor is revoked. Used for deactivation, URL changes, and allowlist removal.';

revoke all on function public.onedash_dead_letter_monitor_jobs(uuid, text)
  from public;

-- Ordinary authenticated users may create schedules with a supported region,
-- but not choose scheduler timestamps. On updates, next_run_at, region,
-- last_run_at, and lease_expires_at are scheduler-owned. The role check stays
-- in an INVOKER trigger so current_user is the actual PostgREST role.
create or replace function public.onedash_guard_schedule_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_schedule_count integer;
begin
  -- Region validity is enforced by the supported_regions foreign keys. Keeping
  -- this check out of the INVOKER trigger avoids granting ordinary users
  -- EXECUTE on an internal SECURITY DEFINER helper.

  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.next_run_at is not null
         or new.last_run_at is not null
         or new.lease_expires_at is not null then
        raise exception 'scheduler fields are operator-managed'
          using errcode = '42501';
      end if;
    elsif new.next_run_at is distinct from old.next_run_at
       or new.region is distinct from old.region
       or new.last_run_at is distinct from old.last_run_at
       or new.lease_expires_at is distinct from old.lease_expires_at then
      raise exception 'scheduler fields are operator-managed'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' then
    select count(*)::integer
    into v_schedule_count
    from public.monitor_schedules s
    where s.monitor_id = new.monitor_id;

    if v_schedule_count >= 5 then
      raise exception 'monitor schedule limit reached' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.onedash_guard_schedule_write() is
  'Enforces the five-schedule-per-monitor limit and prevents ordinary users from modifying scheduler-owned columns. Region validity is enforced by the supported_regions foreign key.';

revoke all on function public.onedash_guard_schedule_write() from public;

drop trigger if exists monitor_schedules_guard_write on public.monitor_schedules;
create trigger monitor_schedules_guard_write
  before insert or update on public.monitor_schedules
  for each row execute function public.onedash_guard_schedule_write();

-- A scheduler tick is already batch-limited, but a monitor with a pathological
-- amount of pending work must not grow without bound. Returning null skips the
-- insert; the scheduler counts it as skipped.
create or replace function public.onedash_guard_check_jobs_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pending integer;
begin
  -- Region validity is enforced by check_jobs_region_fk.

  select count(*)::integer
  into v_pending
  from public.check_jobs j
  where j.monitor_id = new.monitor_id
    and j.status in ('pending', 'leased');

  if v_pending >= 10 then
    return null;
  end if;

  return new;
end;
$$;

comment on function public.onedash_guard_check_jobs_insert() is
  'Caps pending plus leased jobs per monitor at ten. Region validity is enforced by check_jobs_region_fk.';

revoke all on function public.onedash_guard_check_jobs_insert() from public;

drop trigger if exists check_jobs_guard_insert on public.check_jobs;
create trigger check_jobs_guard_insert
  before insert on public.check_jobs
  for each row execute function public.onedash_guard_check_jobs_insert();

create or replace function public.onedash_bind_allowlist_url()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  select m.url
  into v_url
  from public.monitors m
  where m.id = new.monitor_id
    and m.organization_id = new.organization_id;

  if v_url is null then
    raise exception 'allowlisted monitor does not exist' using errcode = '23503';
  end if;
  if new.url is distinct from v_url then
    raise exception 'allowlist URL must match the monitor URL'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

comment on function public.onedash_bind_allowlist_url() is
  'Requires the allowlist URL to equal the current monitor URL. This binds authorization to the exact destination.';

revoke all on function public.onedash_bind_allowlist_url() from public;

drop trigger if exists monitor_execution_allowlist_bind_url
  on public.monitor_execution_allowlist;
create trigger monitor_execution_allowlist_bind_url
  before insert or update on public.monitor_execution_allowlist
  for each row execute function public.onedash_bind_allowlist_url();

create or replace function public.onedash_monitor_authorization_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.url is distinct from old.url then
    -- Authorization is destination-specific. Drop the old authorization row
    -- entirely; an operator must explicitly re-allow the new URL.
    delete from public.monitor_execution_allowlist a
    where a.monitor_id = new.id;
  end if;

  if new.url is distinct from old.url
     or (old.is_active and not new.is_active) then
    perform public.onedash_dead_letter_monitor_jobs(new.id, 'blocked_target');
  end if;

  return new;
end;
$$;

comment on function public.onedash_monitor_authorization_change() is
  'Revokes fixture authorization and terminally fails pending jobs when a monitor URL changes or a monitor is deactivated.';

revoke all on function public.onedash_monitor_authorization_change() from public;

drop trigger if exists monitors_authorization_change on public.monitors;
create trigger monitors_authorization_change
  after update of url, is_active on public.monitors
  for each row execute function public.onedash_monitor_authorization_change();

create or replace function public.onedash_allowlist_revocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.onedash_dead_letter_monitor_jobs(old.monitor_id, 'blocked_target');
  return old;
end;
$$;

comment on function public.onedash_allowlist_revocation() is
  'Terminally fails pending jobs when an operator removes a monitor from the fixture allowlist.';

revoke all on function public.onedash_allowlist_revocation() from public;

drop trigger if exists monitor_execution_allowlist_revocation
  on public.monitor_execution_allowlist;
create trigger monitor_execution_allowlist_revocation
  after delete on public.monitor_execution_allowlist
  for each row execute function public.onedash_allowlist_revocation();

-- ------------------------------------------------------------
-- Strict heartbeat schema
-- ------------------------------------------------------------

create or replace function public.onedash_validate_heartbeat_details(
  p_component text,
  p_details jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_allowed text[];
begin
  if p_details is null or pg_catalog.jsonb_typeof(p_details) <> 'object' then
    raise exception 'heartbeat details must be a JSON object'
      using errcode = '22023';
  end if;

  if p_component = 'scheduler' then
    v_allowed := array[
      'batch_size', 'jitter_seconds', 'last_scheduled', 'last_skipped',
      'execution_mode'
    ];
  elsif p_component = 'worker' then
    v_allowed := array[
      'concurrency', 'in_flight', 'claimed_total', 'completed_total',
      'failed_total', 'retried_total', 'last_error_class'
    ];
  else
    raise exception 'component must be scheduler or worker'
      using errcode = '22023';
  end if;

  if (select count(*) from pg_catalog.jsonb_object_keys(p_details)) <> cardinality(v_allowed) then
    raise exception 'heartbeat details do not match the strict schema'
      using errcode = '22023';
  end if;

  for v_key, v_value in
    select key, value from pg_catalog.jsonb_each(p_details)
  loop
    if not (v_key = any (v_allowed)) then
      raise exception 'unsupported heartbeat detail field' using errcode = '22023';
    end if;
    if pg_catalog.lower(v_key) ~ '(url|host|secret|token|password|authorization|api_key|email|monitor_id|organization_id|database|connection)' then
      raise exception 'heartbeat details contain a sensitive field'
        using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_value) in ('object', 'array') then
      raise exception 'heartbeat details must be flat' using errcode = '22023';
    end if;
  end loop;

  if p_component = 'scheduler' then
    if not (p_details ? 'execution_mode')
       or p_details->>'execution_mode' not in ('disabled', 'fixtures', 'customer') then
      raise exception 'invalid execution mode' using errcode = '22023';
    end if;
    if not (p_details ? 'batch_size')
       or (p_details->>'batch_size') !~ '^[0-9]+$'
       or (p_details->>'batch_size')::integer not between 1 and 100 then
      raise exception 'invalid batch size' using errcode = '22023';
    end if;
    if not (p_details ? 'jitter_seconds')
       or (p_details->>'jitter_seconds') !~ '^[0-9]+$'
       or (p_details->>'jitter_seconds')::integer not between 0 and 30 then
      raise exception 'invalid jitter seconds' using errcode = '22023';
    end if;
    if not (p_details ? 'last_scheduled')
       or (p_details->>'last_scheduled') !~ '^[0-9]+$'
       or (p_details->>'last_scheduled')::bigint > 1000000 then
      raise exception 'invalid scheduled count' using errcode = '22023';
    end if;
    if not (p_details ? 'last_skipped')
       or (p_details->>'last_skipped') !~ '^[0-9]+$'
       or (p_details->>'last_skipped')::bigint > 1000000 then
      raise exception 'invalid skipped count' using errcode = '22023';
    end if;
  else
    if not (p_details ? 'concurrency')
       or (p_details->>'concurrency') !~ '^[0-9]+$'
       or (p_details->>'concurrency')::integer not between 1 and 10 then
      raise exception 'invalid concurrency' using errcode = '22023';
    end if;
    if not (p_details ? 'in_flight')
       or (p_details->>'in_flight') !~ '^[0-9]+$'
       or (p_details->>'in_flight')::integer not between 0 and 10 then
      raise exception 'invalid in-flight count' using errcode = '22023';
    end if;
    if (p_details->>'in_flight')::integer > (p_details->>'concurrency')::integer then
      raise exception 'in-flight count exceeds concurrency' using errcode = '22023';
    end if;
    if not (p_details ? 'claimed_total')
       or (p_details->>'claimed_total') !~ '^[0-9]+$'
       or (p_details->>'claimed_total')::bigint > 1000000000000 then
      raise exception 'invalid claimed count' using errcode = '22023';
    end if;
    if not (p_details ? 'completed_total')
       or (p_details->>'completed_total') !~ '^[0-9]+$'
       or (p_details->>'completed_total')::bigint > 1000000000000 then
      raise exception 'invalid completed count' using errcode = '22023';
    end if;
    if not (p_details ? 'failed_total')
       or (p_details->>'failed_total') !~ '^[0-9]+$'
       or (p_details->>'failed_total')::bigint > 1000000000000 then
      raise exception 'invalid failed count' using errcode = '22023';
    end if;
    if not (p_details ? 'retried_total')
       or (p_details->>'retried_total') !~ '^[0-9]+$'
       or (p_details->>'retried_total')::bigint > 1000000000000 then
      raise exception 'invalid retried count' using errcode = '22023';
    end if;
    if not (p_details ? 'last_error_class') then
      raise exception 'missing last_error_class' using errcode = '22023';
    end if;
    if p_details->>'last_error_class' is not null
       and pg_catalog.lower(p_details->>'last_error_class')
         !~ '^[a-z0-9_]{1,64}$' then
      raise exception 'invalid last error class' using errcode = '22023';
    end if;
  end if;
end;
$$;

comment on function public.onedash_validate_heartbeat_details(text, jsonb) is
  'Strict flat heartbeat schema. Rejects unknown, nested, case-variant sensitive fields and bounds every numeric field, including worker concurrency.';

revoke all on function public.onedash_validate_heartbeat_details(text, jsonb)
  from public;

create or replace function public.onedash_guard_heartbeat_details()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.onedash_validate_heartbeat_details(new.component, new.details);
  return new;
end;
$$;

comment on function public.onedash_guard_heartbeat_details() is
  'Applies the strict heartbeat schema to direct inserts and updates as well as the restricted function.';

revoke all on function public.onedash_guard_heartbeat_details() from public;

drop trigger if exists service_heartbeats_guard_details
  on public.service_heartbeats;
create trigger service_heartbeats_guard_details
  before insert or update on public.service_heartbeats
  for each row execute function public.onedash_guard_heartbeat_details();

create or replace function public.onedash_cleanup_stale_heartbeats(
  p_older_than_seconds integer default 86400
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_older_than_seconds is null
     or p_older_than_seconds < 60
     or p_older_than_seconds > 31536000 then
    raise exception 'heartbeat retention must be between 60 and 31536000 seconds'
      using errcode = '22023';
  end if;

  delete from public.service_heartbeats
  where last_seen_at < pg_catalog.now()
    - pg_catalog.make_interval(secs => p_older_than_seconds);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.onedash_cleanup_stale_heartbeats(integer) is
  'Deletes stale heartbeat rows so the internal table cannot grow without bound.';

revoke all on function public.onedash_cleanup_stale_heartbeats(integer)
  from public;

-- ------------------------------------------------------------
-- Result payload validation (safe vocabulary and status assertions)
-- ------------------------------------------------------------

create or replace function public.onedash_validate_result_payload(p_result jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
  v_status text;
  v_error_class text;
  v_error_message text;
  v_expected_message text;
  v_checked_at timestamptz;
  v_allowed_fields text[] := array[
    'status', 'http_status', 'response_time_ms', 'dns_ms', 'connect_ms',
    'tls_ms', 'ttfb_ms', 'total_ms', 'error_class', 'error_message',
    'redirect_count', 'response_bytes', 'checked_at'
  ];
  v_allowed_error_classes text[] := array[
    'dns_failure', 'connection_refused', 'connection_failure', 'timeout',
    'tls_error', 'http_status_mismatch', 'body_mismatch', 'redirect_loop',
    'redirect_failure', 'blocked_target', 'response_too_large',
    'unsupported_configuration', 'internal_error', 'latency_threshold'
  ];
begin
  if p_result is null or pg_catalog.jsonb_typeof(p_result) <> 'object' then
    raise exception 'check result must be a JSON object' using errcode = '22023';
  end if;

  for v_key in select pg_catalog.jsonb_object_keys(p_result) loop
    if not (v_key = any (v_allowed_fields)) then
      raise exception 'check result contains unsupported field: %', v_key
        using errcode = '22023';
    end if;
  end loop;

  if not (p_result ? 'status') or not (p_result ? 'checked_at') then
    raise exception 'check result requires status and checked_at'
      using errcode = '22023';
  end if;

  v_status := p_result->>'status';
  if v_status is null or v_status not in ('up', 'down', 'error') then
    raise exception 'invalid check result status' using errcode = '22023';
  end if;

  v_checked_at := (p_result->>'checked_at')::timestamptz;
  if v_checked_at is null then
    raise exception 'checked_at is required' using errcode = '22023';
  end if;
  if v_checked_at > pg_catalog.now() + pg_catalog.make_interval(mins => 5) then
    raise exception 'checked_at is too far in the future' using errcode = '22023';
  end if;

  if p_result ? 'http_status' and p_result->>'http_status' is not null then
    if (p_result->>'http_status')::integer not between 100 and 599 then
      raise exception 'http_status must be between 100 and 599'
        using errcode = '22023';
    end if;
  end if;

  if not (p_result ? 'response_time_ms')
     or p_result->>'response_time_ms' is null
     or (p_result->>'response_time_ms')::integer < 0 then
    raise exception 'response_time_ms is required and must be non-negative'
      using errcode = '22023';
  end if;

  if not (p_result ? 'total_ms')
     or p_result->>'total_ms' is null
     or (p_result->>'total_ms')::integer < 0 then
    raise exception 'total_ms is required and must be non-negative'
      using errcode = '22023';
  end if;

  if p_result ? 'dns_ms' and p_result->>'dns_ms' is not null
     and (p_result->>'dns_ms')::integer < 0 then
    raise exception 'dns_ms must be non-negative' using errcode = '22023';
  end if;
  if p_result ? 'connect_ms' and p_result->>'connect_ms' is not null
     and (p_result->>'connect_ms')::integer < 0 then
    raise exception 'connect_ms must be non-negative' using errcode = '22023';
  end if;
  if p_result ? 'tls_ms' and p_result->>'tls_ms' is not null
     and (p_result->>'tls_ms')::integer < 0 then
    raise exception 'tls_ms must be non-negative' using errcode = '22023';
  end if;
  if p_result ? 'ttfb_ms' and p_result->>'ttfb_ms' is not null
     and (p_result->>'ttfb_ms')::integer < 0 then
    raise exception 'ttfb_ms must be non-negative' using errcode = '22023';
  end if;

  if not (p_result ? 'redirect_count')
     or p_result->>'redirect_count' is null
     or (p_result->>'redirect_count')::integer not between 0 and 5 then
    raise exception 'redirect_count is required and must be between 0 and 5'
      using errcode = '22023';
  end if;

  if p_result ? 'response_bytes' and p_result->>'response_bytes' is not null
     and (p_result->>'response_bytes')::integer < 0 then
    raise exception 'response_bytes must be non-negative'
      using errcode = '22023';
  end if;

  v_error_class := nullif(p_result->>'error_class', '');
  if v_error_class is not null
     and not (v_error_class = any (v_allowed_error_classes)) then
    raise exception 'unsupported error_class' using errcode = '22023';
  end if;

  if v_status = 'up' and v_error_class is not null then
    raise exception 'up results cannot have an error_class'
      using errcode = '22023';
  end if;
  if v_status <> 'up' and v_error_class is null then
    raise exception 'failed results require an error_class'
      using errcode = '22023';
  end if;

  v_error_message := nullif(p_result->>'error_message', '');
  if v_error_class is null then
    if v_error_message is not null then
      raise exception 'successful results cannot have an error_message'
        using errcode = '22023';
    end if;
  else
    v_expected_message := case v_error_class
      when 'dns_failure' then 'DNS resolution failed.'
      when 'connection_refused' then 'The destination refused the connection.'
      when 'connection_failure' then 'The connection to the destination failed.'
      when 'timeout' then 'The check timed out.'
      when 'tls_error' then 'TLS negotiation or certificate verification failed.'
      when 'http_status_mismatch' then 'The response status did not match the expected status.'
      when 'body_mismatch' then 'The response body did not match the expected content.'
      when 'redirect_loop' then 'The redirect chain looped or exceeded the allowed number of hops.'
      when 'redirect_failure' then 'The redirect could not be followed safely.'
      when 'blocked_target' then 'The destination is not allowed.'
      when 'response_too_large' then 'The response exceeded the checker''s size limit.'
      when 'unsupported_configuration' then 'The monitor configuration is not supported by this checker version.'
      when 'internal_error' then 'The checker encountered an internal error.'
      when 'latency_threshold' then 'The response exceeded the latency threshold.'
      else null
    end;

    if v_expected_message is null or v_error_message is distinct from v_expected_message then
      raise exception 'error_message is not the safe message for its error_class'
        using errcode = '22023';
    end if;
  end if;
end;
$$;

comment on function public.onedash_validate_result_payload(jsonb) is
  'Strict result validation. Failed results must use the fixed safe message for their error class so raw URLs, headers, bodies, or transport text cannot be stored.';

revoke all on function public.onedash_validate_result_payload(jsonb) from public;

-- ------------------------------------------------------------
-- Recreate scheduler, queue, and ingestor functions
-- ------------------------------------------------------------

create or replace function public.onedash_schedule_due_jobs(
  p_batch_size integer default 50,
  p_jitter_seconds integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_exec public.monitor_execution_settings%rowtype;
  v_row record;
  v_due timestamptz;
  v_next timestamptz;
  v_candidate timestamptz;
  v_interval interval;
  v_jitter integer;
  v_key text;
  v_inserted integer;
  v_scheduled integer := 0;
  v_skipped integer := 0;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 100 then
    raise exception 'batch size must be between 1 and 100' using errcode = '22023';
  end if;
  if p_jitter_seconds is null or p_jitter_seconds < 0 or p_jitter_seconds > 30 then
    raise exception 'jitter seconds must be between 0 and 30'
      using errcode = '22023';
  end if;

  select * into v_exec
  from public.monitor_execution_settings
  where singleton;

  if not found or not v_exec.execution_enabled or v_exec.mode = 'disabled' then
    return pg_catalog.jsonb_build_object(
      'scheduled', 0,
      'skipped', 0,
      'execution_mode', coalesce(v_exec.mode, 'disabled'),
      'reason', coalesce(v_exec.reason, 'execution disabled')
    );
  end if;

  if v_exec.mode = 'customer' then
    return pg_catalog.jsonb_build_object(
      'scheduled', 0,
      'skipped', 0,
      'execution_mode', v_exec.mode,
      'reason', 'customer execution is not implemented in Phase 4B'
    );
  end if;

  for v_row in
    select
      s.id as schedule_id,
      s.monitor_id,
      s.organization_id,
      s.region,
      s.next_run_at,
      m.interval_seconds
    from public.monitor_schedules s
    join public.monitors m
      on m.id = s.monitor_id
     and m.organization_id = s.organization_id
    join public.monitor_execution_allowlist a
      on a.monitor_id = m.id
     and a.organization_id = m.organization_id
     and a.url = m.url
    where m.is_active
      and s.next_run_at is not null
      and s.next_run_at <= v_now
    order by s.next_run_at, s.id
    limit p_batch_size
    for update of s skip locked
  loop
    v_due := v_row.next_run_at;
    v_key :=
      'sched:'
      || v_row.monitor_id::text
      || ':'
      || v_row.region
      || ':'
      || pg_catalog.to_char(
           v_due at time zone 'UTC',
           'YYYYMMDDHH24MISSUS'
         );

    if p_jitter_seconds = 0 then
      v_jitter := 0;
    else
      v_jitter := pg_catalog.mod(
        pg_catalog.abs(pg_catalog.hashtextextended(v_key, 0)),
        (p_jitter_seconds + 1)::bigint
      )::integer;
    end if;

    insert into public.check_jobs (
      organization_id,
      monitor_id,
      region,
      scheduled_for,
      available_at,
      idempotency_key,
      status,
      attempts,
      max_attempts
    )
    values (
      v_row.organization_id,
      v_row.monitor_id,
      v_row.region,
      v_due,
      v_due + pg_catalog.make_interval(secs => v_jitter),
      v_key,
      'pending',
      0,
      5
    )
    on conflict do nothing;

    get diagnostics v_inserted = row_count;
    if v_inserted > 0 then
      v_scheduled := v_scheduled + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    v_interval := pg_catalog.make_interval(secs => v_row.interval_seconds);
    v_candidate := v_due + v_interval;

    if v_candidate <= v_now then
      v_next := v_now + v_interval;
    else
      v_next := v_candidate;
    end if;

    update public.monitor_schedules
    set next_run_at = v_next,
        last_run_at = v_now,
        lease_expires_at = null,
        updated_at = v_now
    where id = v_row.schedule_id;
  end loop;

  return pg_catalog.jsonb_build_object(
    'scheduled', v_scheduled,
    'skipped', v_skipped,
    'execution_mode', v_exec.mode,
    'evaluated_at', v_now
  );
end;
$$;

comment on function public.onedash_schedule_due_jobs(integer, integer) is
  'Creates at most one unique job per due monitor slot. Authorization now requires the allowlist URL to equal the current monitor URL.';

revoke all on function public.onedash_schedule_due_jobs(integer, integer)
  from public;

create or replace function public.onedash_claim_jobs(
  p_worker_id text,
  p_region text,
  p_lease_seconds integer,
  p_batch_size integer,
  p_allowed_hosts text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_exec public.monitor_execution_settings%rowtype;
  v_hosts text[];
  v_jobs jsonb;
begin
  if p_worker_id is null
     or char_length(p_worker_id) not between 1 and 100 then
    raise exception 'worker id must be between 1 and 100 characters'
      using errcode = '22023';
  end if;
  if p_region is null
     or char_length(p_region) not between 2 and 32
     or p_region !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid region' using errcode = '22023';
  end if;
  perform public.onedash_require_supported_region(p_region);
  if p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 600 then
    raise exception 'lease seconds must be between 30 and 600'
      using errcode = '22023';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 10 then
    raise exception 'batch size must be between 1 and 10'
      using errcode = '22023';
  end if;

  select * into v_exec
  from public.monitor_execution_settings
  where singleton;

  if not found or not v_exec.execution_enabled or v_exec.mode = 'disabled' then
    return pg_catalog.jsonb_build_object(
      'jobs', '[]'::jsonb,
      'execution_mode', coalesce(v_exec.mode, 'disabled'),
      'reason', coalesce(v_exec.reason, 'execution disabled')
    );
  end if;

  if v_exec.mode = 'customer' then
    return pg_catalog.jsonb_build_object(
      'jobs', '[]'::jsonb,
      'execution_mode', v_exec.mode,
      'reason', 'customer execution is not implemented in Phase 4B'
    );
  end if;

  if p_allowed_hosts is null
     or cardinality(p_allowed_hosts) = 0
     or cardinality(p_allowed_hosts) > 20 then
    return pg_catalog.jsonb_build_object(
      'jobs', '[]'::jsonb,
      'execution_mode', v_exec.mode,
      'reason', 'fixture host allowlist is required'
    );
  end if;

  select pg_catalog.array_agg(pg_catalog.lower(pg_catalog.btrim(host)))
  into v_hosts
  from pg_catalog.unnest(p_allowed_hosts) as hosts(host);

  if exists (
    select 1
    from pg_catalog.unnest(v_hosts) as hosts(host)
    where not public.onedash_is_fixture_hostname(host)
  ) then
    raise exception 'invalid fixture host allowlist' using errcode = '22023';
  end if;

  with candidates as (
    select j.id
    from public.check_jobs j
    join public.monitors m
      on m.id = j.monitor_id
     and m.organization_id = j.organization_id
    join public.monitor_execution_allowlist a
      on a.monitor_id = m.id
     and a.organization_id = m.organization_id
     and a.url = m.url
    where j.status = 'pending'
      and j.region = p_region
      and j.available_at <= v_now
      and j.attempts < j.max_attempts
      and m.is_active
      and pg_catalog.lower(
            pg_catalog.substring(
              m.url,
              '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)'
            )
          ) = any (v_hosts)
    order by j.available_at, j.id
    limit p_batch_size
    for update of j skip locked
  ),
  claimed as (
    update public.check_jobs j
    set status = 'leased',
        attempts = j.attempts + 1,
        lease_owner = p_worker_id,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
        completion_token = null,
        updated_at = v_now
    from candidates c
    where j.id = c.id
    returning j.*
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'job_id', c.id,
        'lease_token', c.lease_token,
        'monitor_id', c.monitor_id,
        'region', c.region,
        'scheduled_for', c.scheduled_for,
        'attempts', c.attempts,
        'max_attempts', c.max_attempts,
        'url', m.url,
        'method', m.method,
        'expected_status_codes', m.expected_status_codes,
        'timeout_seconds', m.timeout_seconds,
        'verify_tls', m.verify_tls,
        'follow_redirects', m.follow_redirects,
        'max_redirects', m.max_redirects,
        'has_request_secrets', exists (
          select 1
          from public.monitor_request_secrets s
          where s.monitor_id = m.id
        )
      )
      order by c.available_at, c.id
    ),
    '[]'::jsonb
  )
  into v_jobs
  from claimed c
  join public.monitors m
    on m.id = c.monitor_id
   and m.organization_id = c.organization_id;

  return pg_catalog.jsonb_build_object(
    'jobs', v_jobs,
    'execution_mode', v_exec.mode,
    'claimed_at', v_now
  );
end;
$$;

comment on function public.onedash_claim_jobs(text, text, integer, integer, text[]) is
  'Claims pending fixture jobs using FOR UPDATE SKIP LOCKED. The allowlist is bound to the exact monitor URL and the host allowlist accepts only .test names.';

revoke all on function public.onedash_claim_jobs(text, text, integer, integer, text[])
  from public;

create or replace function public.onedash_extend_lease(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_expires timestamptz;
  v_updated integer;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'lease seconds must be between 30 and 600'
      using errcode = '22023';
  end if;

  v_expires := v_now + pg_catalog.make_interval(secs => p_lease_seconds);

  update public.check_jobs
  set lease_expires_at = v_expires,
      updated_at = v_now
  where id = p_job_id
    and status = 'leased'
    and lease_token = p_lease_token
    and lease_expires_at > v_now;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'lease_mismatch_or_expired'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'lease_expires_at', v_expires
  );
end;
$$;

comment on function public.onedash_extend_lease(uuid, uuid, integer) is
  'Extends a live lease only. An expired lease cannot be revived.';

revoke all on function public.onedash_extend_lease(uuid, uuid, integer)
  from public;

create or replace function public.onedash_release_job(
  p_job_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_status public.check_job_status;
  v_updated integer;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required' using errcode = '22023';
  end if;

  update public.check_jobs
  set status = case
        when attempts >= max_attempts
          then 'dead_letter'::public.check_job_status
        else 'pending'::public.check_job_status
      end,
      available_at = case
        when attempts >= max_attempts then available_at
        else v_now
      end,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      completion_token = null,
      last_error_class = 'worker_shutdown',
      last_failure_at = v_now,
      dead_letter_at = case
        when attempts >= max_attempts then v_now
        else null
      end,
      completed_at = null,
      updated_at = v_now
  where id = p_job_id
    and status = 'leased'
    and lease_token = p_lease_token
    and lease_expires_at > v_now
  returning status into v_status;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'lease_mismatch_or_expired'
    );
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

comment on function public.onedash_release_job(uuid, uuid) is
  'Releases a job only while its lease is still live. An expired lease is left to the reaper so a stale worker cannot resurrect it.';

revoke all on function public.onedash_release_job(uuid, uuid)
  from public;

create or replace function public.onedash_fail_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_class text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_job public.check_jobs%rowtype;
  v_retryable boolean;
  v_delay integer;
  v_retry_at timestamptz;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required' using errcode = '22023';
  end if;
  if p_error_class is null
     or p_error_class not in (
       'internal_error', 'timeout', 'worker_error',
       'worker_shutdown', 'blocked_target'
     ) then
    raise exception 'unsupported job error class' using errcode = '22023';
  end if;

  v_retryable := coalesce(p_retryable, false);

  select * into v_job
  from public.check_jobs
  where id = p_job_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'job_not_found');
  end if;
  if v_job.status = 'completed' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'lease_mismatch_or_expired'
    );
  end if;

  if not v_retryable or v_job.attempts >= v_job.max_attempts then
    update public.check_jobs
    set status = 'dead_letter',
        dead_letter_at = v_now,
        completed_at = null,
        completion_token = null,
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        last_error_class = p_error_class,
        last_failure_at = v_now,
        updated_at = v_now
    where id = p_job_id;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'status', 'dead_letter',
      'attempts', v_job.attempts,
      'max_attempts', v_job.max_attempts
    );
  end if;

  v_delay := public.onedash_job_backoff_seconds(v_job.attempts);
  v_retry_at := v_now + pg_catalog.make_interval(secs => v_delay);

  update public.check_jobs
  set status = 'pending',
      available_at = v_retry_at,
      dead_letter_at = null,
      completed_at = null,
      completion_token = null,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_class = p_error_class,
      last_failure_at = v_now,
      updated_at = v_now
  where id = p_job_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', 'pending',
    'retry_at', v_retry_at,
    'attempts', v_job.attempts,
    'max_attempts', v_job.max_attempts
  );
end;
$$;

comment on function public.onedash_fail_job(uuid, uuid, text, boolean) is
  'Retries only transient failures, dead-letters immediately when p_retryable is false, and requires the original live lease.';

revoke all on function public.onedash_fail_job(uuid, uuid, text, boolean)
  from public;

create or replace function public.onedash_reap_expired_leases(
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_row record;
  v_delay integer;
  v_recovered integer := 0;
  v_dead integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100' using errcode = '22023';
  end if;

  for v_row in
    select id, attempts, max_attempts
    from public.check_jobs
    where status = 'leased'
      and lease_expires_at < v_now
    order by lease_expires_at, id
    limit p_limit
    for update skip locked
  loop
    if v_row.attempts >= v_row.max_attempts then
      update public.check_jobs
      set status = 'dead_letter',
          dead_letter_at = v_now,
          completed_at = null,
          completion_token = null,
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          lease_expired_count = lease_expired_count + 1,
          last_error_class = 'lease_expired',
          last_failure_at = v_now,
          updated_at = v_now
      where id = v_row.id;
      v_dead := v_dead + 1;
    else
      v_delay := public.onedash_job_backoff_seconds(v_row.attempts);
      update public.check_jobs
      set status = 'pending',
          available_at = v_now + pg_catalog.make_interval(secs => v_delay),
          dead_letter_at = null,
          completed_at = null,
          completion_token = null,
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          lease_expired_count = lease_expired_count + 1,
          last_error_class = 'lease_expired',
          last_failure_at = v_now,
          updated_at = v_now
      where id = v_row.id;
      v_recovered := v_recovered + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'recovered', v_recovered,
    'dead_lettered', v_dead,
    'reaped_at', v_now
  );
end;
$$;

comment on function public.onedash_reap_expired_leases(integer) is
  'Recovers expired leases with backoff or dead-letters exhausted jobs. Clears completion ownership.';

revoke all on function public.onedash_reap_expired_leases(integer)
  from public;

create or replace function public.onedash_acknowledge_job(
  p_job_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_job public.check_jobs%rowtype;
  v_result_id uuid;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required' using errcode = '22023';
  end if;

  select * into v_job
  from public.check_jobs
  where id = p_job_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'job_not_found');
  end if;
  if v_job.status = 'completed' then
    if v_job.completion_token is distinct from p_lease_token then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'lease_mismatch');
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'job_status', 'completed',
      'result_id', v_job.result_id
    );
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'lease_mismatch_or_expired'
    );
  end if;

  select id into v_result_id
  from public.check_results
  where monitor_id = v_job.monitor_id
    and idempotency_key = v_job.idempotency_key;

  if v_result_id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'result_not_found');
  end if;

  update public.check_jobs
  set status = 'completed',
      completed_at = v_now,
      result_id = v_result_id,
      completion_token = p_lease_token,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_class = null,
      updated_at = v_now
  where id = p_job_id
    and status = 'leased'
    and lease_token = p_lease_token
    and lease_expires_at > v_now;

  if not found then
    raise exception 'job lease was lost during acknowledgement'
      using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'job_status', 'completed',
    'result_id', v_result_id
  );
end;
$$;

comment on function public.onedash_acknowledge_job(uuid, uuid) is
  'Acknowledges a completed job only with a live lease or the original completion token. A stale token cannot claim a completed duplicate.';

revoke all on function public.onedash_acknowledge_job(uuid, uuid)
  from public;

create or replace function public.onedash_ingest_check_result(
  p_job_id uuid,
  p_lease_token uuid,
  p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_job public.check_jobs%rowtype;
  v_status public.check_status;
  v_checked_at timestamptz;
  v_http_status integer;
  v_response_time_ms integer;
  v_dns_ms integer;
  v_connect_ms integer;
  v_tls_ms integer;
  v_ttfb_ms integer;
  v_total_ms integer;
  v_error_class text;
  v_error_message text;
  v_redirect_count integer;
  v_response_bytes integer;
  v_expected_status_codes integer[];
  v_result_id uuid;
  v_inserted boolean := false;
  v_monitor_status public.monitor_status;
  v_updated integer;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required' using errcode = '22023';
  end if;

  perform public.onedash_validate_result_payload(p_result);

  select * into v_job
  from public.check_jobs
  where id = p_job_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'job_not_found');
  end if;

  if v_job.status = 'completed' then
    if v_job.completion_token is distinct from p_lease_token then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'lease_mismatch');
    end if;

    select id into v_result_id
    from public.check_results
    where monitor_id = v_job.monitor_id
      and idempotency_key = v_job.idempotency_key;

    if v_result_id is not null then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'duplicate', true,
        'job_status', 'completed',
        'result_id', v_result_id
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'job_completed_without_result'
    );
  end if;

  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'lease_mismatch_or_expired'
    );
  end if;

  select m.expected_status_codes
  into v_expected_status_codes
  from public.monitors m
  where m.id = v_job.monitor_id
    and m.organization_id = v_job.organization_id;

  if v_expected_status_codes is null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'monitor_not_found');
  end if;

  v_status := (p_result->>'status')::public.check_status;
  v_checked_at := (p_result->>'checked_at')::timestamptz;
  v_http_status := nullif(p_result->>'http_status', '')::integer;
  v_response_time_ms := (p_result->>'response_time_ms')::integer;
  v_dns_ms := nullif(p_result->>'dns_ms', '')::integer;
  v_connect_ms := nullif(p_result->>'connect_ms', '')::integer;
  v_tls_ms := nullif(p_result->>'tls_ms', '')::integer;
  v_ttfb_ms := nullif(p_result->>'ttfb_ms', '')::integer;
  v_total_ms := (p_result->>'total_ms')::integer;
  v_error_class := nullif(p_result->>'error_class', '');
  v_error_message := nullif(p_result->>'error_message', '');
  v_redirect_count := (p_result->>'redirect_count')::integer;
  v_response_bytes := nullif(p_result->>'response_bytes', '')::integer;

  if v_status::text not in ('up', 'down', 'error') then
    raise exception 'invalid check result status' using errcode = '22023';
  end if;

  if v_status = 'up' then
    if v_http_status is null
       or not (v_http_status = any (v_expected_status_codes)) then
      raise exception 'up result status is not in the monitor expected status codes'
        using errcode = '22023';
    end if;
  elsif v_error_class = 'http_status_mismatch' then
    if v_http_status is null
       or v_http_status = any (v_expected_status_codes) then
      raise exception 'http_status_mismatch result status is still expected'
        using errcode = '22023';
    end if;
  end if;

  v_monitor_status := case
    when v_status = 'up' then 'up'::public.monitor_status
    else 'down'::public.monitor_status
  end;

  insert into public.check_results (
    organization_id,
    monitor_id,
    region,
    status,
    http_status,
    response_time_ms,
    dns_ms,
    connect_ms,
    tls_ms,
    ttfb_ms,
    total_ms,
    error_class,
    error_message,
    checked_at,
    scheduled_at,
    idempotency_key,
    redirect_count,
    response_bytes
  )
  values (
    v_job.organization_id,
    v_job.monitor_id,
    v_job.region,
    v_status,
    v_http_status,
    v_response_time_ms,
    v_dns_ms,
    v_connect_ms,
    v_tls_ms,
    v_ttfb_ms,
    v_total_ms,
    v_error_class,
    v_error_message,
    v_checked_at,
    v_job.scheduled_for,
    v_job.idempotency_key,
    v_redirect_count,
    v_response_bytes
  )
  on conflict (monitor_id, idempotency_key) do nothing
  returning id into v_result_id;

  if v_result_id is not null then
    v_inserted := true;
  else
    select id into v_result_id
    from public.check_results
    where monitor_id = v_job.monitor_id
      and idempotency_key = v_job.idempotency_key;

    if v_result_id is null then
      raise exception 'result conflict without an existing result'
        using errcode = 'XX000';
    end if;
  end if;

  if v_inserted then
    insert into public.monitor_state (
      monitor_id,
      organization_id,
      status,
      consecutive_failures,
      consecutive_successes,
      last_checked_at,
      last_status_change_at
    )
    values (
      v_job.monitor_id,
      v_job.organization_id,
      v_monitor_status,
      case when v_monitor_status = 'up' then 0 else 1 end,
      case when v_monitor_status = 'up' then 1 else 0 end,
      v_checked_at,
      v_checked_at
    )
    on conflict (monitor_id) do update
    set status = excluded.status,
        consecutive_failures = case
          when excluded.status = 'up' then 0
          else public.monitor_state.consecutive_failures + 1
        end,
        consecutive_successes = case
          when excluded.status = 'up'
            then public.monitor_state.consecutive_successes + 1
          else 0
        end,
        last_checked_at = excluded.last_checked_at,
        last_status_change_at = case
          when public.monitor_state.status is distinct from excluded.status
            then excluded.last_checked_at
          else public.monitor_state.last_status_change_at
        end,
        updated_at = v_now
    where public.monitor_state.last_checked_at is null
       or excluded.last_checked_at >= public.monitor_state.last_checked_at;
  end if;

  update public.check_jobs
  set status = 'completed',
      completed_at = v_now,
      result_id = v_result_id,
      completion_token = p_lease_token,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_class = null,
      updated_at = v_now
  where id = v_job.id
    and status = 'leased'
    and lease_token = p_lease_token
    and lease_expires_at > v_now;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'job lease was lost during result ingestion'
      using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', not v_inserted,
    'job_status', 'completed',
    'result_id', v_result_id,
    'monitor_status', v_monitor_status
  );
end;
$$;

comment on function public.onedash_ingest_check_result(uuid, uuid, jsonb) is
  'Stores one validated result, enforces expected status codes, requires a live lease or the matching completion token, and completes the job atomically.';

revoke all on function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  from public;

create or replace function public.onedash_record_heartbeat(
  p_component text,
  p_instance_id text,
  p_region text,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
begin
  if p_component is null or p_component not in ('scheduler', 'worker') then
    raise exception 'component must be scheduler or worker'
      using errcode = '22023';
  end if;
  if p_instance_id is null
     or char_length(p_instance_id) not between 1 and 100 then
    raise exception 'instance id must be between 1 and 100 characters'
      using errcode = '22023';
  end if;
  if p_region is null
     or char_length(p_region) not between 2 and 32
     or p_region !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid region' using errcode = '22023';
  end if;
  perform public.onedash_require_supported_region(p_region);
  perform public.onedash_validate_heartbeat_details(p_component, p_details);

  insert into public.service_heartbeats (
    component,
    instance_id,
    region,
    started_at,
    last_seen_at,
    details
  )
  values (
    p_component,
    p_instance_id,
    p_region,
    v_now,
    v_now,
    p_details
  )
  on conflict (component, instance_id) do update
  set region = excluded.region,
      last_seen_at = excluded.last_seen_at,
      details = excluded.details;

  return pg_catalog.jsonb_build_object('ok', true, 'last_seen_at', v_now);
end;
$$;

comment on function public.onedash_record_heartbeat(text, text, text, jsonb) is
  'Records an internal heartbeat after strict flat-schema validation. Concurrency and all counters are bounded.';

revoke all on function public.onedash_record_heartbeat(text, text, text, jsonb)
  from public;

-- ------------------------------------------------------------
-- Function ownership and grants
-- ------------------------------------------------------------

alter function public.onedash_require_supported_region(text)
  owner to onedash_function_owner;
alter function public.onedash_dead_letter_monitor_jobs(uuid, text)
  owner to onedash_function_owner;
alter function public.onedash_bind_allowlist_url()
  owner to onedash_function_owner;
alter function public.onedash_monitor_authorization_change()
  owner to onedash_function_owner;
alter function public.onedash_allowlist_revocation()
  owner to onedash_function_owner;
alter function public.onedash_cleanup_stale_heartbeats(integer)
  owner to onedash_function_owner;
alter function public.onedash_schedule_due_jobs(integer, integer)
  owner to onedash_function_owner;
alter function public.onedash_claim_jobs(text, text, integer, integer, text[])
  owner to onedash_function_owner;
alter function public.onedash_extend_lease(uuid, uuid, integer)
  owner to onedash_function_owner;
alter function public.onedash_release_job(uuid, uuid)
  owner to onedash_function_owner;
alter function public.onedash_fail_job(uuid, uuid, text, boolean)
  owner to onedash_function_owner;
alter function public.onedash_reap_expired_leases(integer)
  owner to onedash_function_owner;
alter function public.onedash_acknowledge_job(uuid, uuid)
  owner to onedash_function_owner;
alter function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  owner to onedash_function_owner;
alter function public.onedash_record_heartbeat(text, text, text, jsonb)
  owner to onedash_function_owner;

-- The function owner is NOLOGIN and is not granted to any login role. These
-- table grants and RLS policies are only reachable through the functions above.
grant usage on schema public to onedash_function_owner;
grant select on table
  public.monitors,
  public.monitor_schedules,
  public.monitor_execution_settings,
  public.monitor_execution_allowlist,
  public.monitor_request_secrets,
  public.check_jobs,
  public.check_results,
  public.monitor_state,
  public.service_heartbeats,
  public.supported_regions
  to onedash_function_owner;
grant insert, update on table
  public.monitor_schedules,
  public.check_jobs,
  public.check_results,
  public.monitor_state,
  public.service_heartbeats
  to onedash_function_owner;
grant insert on table public.check_jobs to onedash_function_owner;
grant delete on table public.monitor_execution_allowlist
  to onedash_function_owner;
grant delete on table public.service_heartbeats
  to onedash_function_owner;

-- The SECURITY DEFINER functions run with current_user =
-- onedash_function_owner, so they need EXECUTE on the internal helpers they
-- call. These helpers remain revoked from PUBLIC and application roles.
grant execute on function
  public.onedash_is_fixture_hostname(text),
  public.onedash_job_backoff_seconds(integer),
  public.onedash_validate_heartbeat_details(text, jsonb),
  public.onedash_validate_result_payload(jsonb)
  to onedash_function_owner;

drop policy if exists "function owner can read execution settings"
  on public.monitor_execution_settings;
create policy "function owner can read execution settings"
  on public.monitor_execution_settings
  for select to onedash_function_owner
  using (true);

drop policy if exists "function owner can manage schedules"
  on public.monitor_schedules;
create policy "function owner can manage schedules"
  on public.monitor_schedules
  for all to onedash_function_owner
  using (true)
  with check (true);

drop policy if exists "function owner can read monitors"
  on public.monitors;
create policy "function owner can read monitors"
  on public.monitors
  for select to onedash_function_owner
  using (true);

drop policy if exists "function owner can manage allowlist"
  on public.monitor_execution_allowlist;
create policy "function owner can manage allowlist"
  on public.monitor_execution_allowlist
  for all to onedash_function_owner
  using (true)
  with check (true);

drop policy if exists "function owner can read request secrets"
  on public.monitor_request_secrets;
create policy "function owner can read request secrets"
  on public.monitor_request_secrets
  for select to onedash_function_owner
  using (true);

drop policy if exists "function owner can manage jobs"
  on public.check_jobs;
create policy "function owner can manage jobs"
  on public.check_jobs
  for all to onedash_function_owner
  using (true)
  with check (true);

drop policy if exists "function owner can manage results"
  on public.check_results;
create policy "function owner can manage results"
  on public.check_results
  for all to onedash_function_owner
  using (true)
  with check (true);

drop policy if exists "function owner can manage monitor state"
  on public.monitor_state;
create policy "function owner can manage monitor state"
  on public.monitor_state
  for all to onedash_function_owner
  using (true)
  with check (true);

drop policy if exists "function owner can manage heartbeats"
  on public.service_heartbeats;
create policy "function owner can manage heartbeats"
  on public.service_heartbeats
  for all to onedash_function_owner
  using (true)
  with check (true);

drop policy if exists "function owner can read supported regions"
  on public.supported_regions;
create policy "function owner can read supported regions"
  on public.supported_regions
  for select to onedash_function_owner
  using (true);

grant usage on schema public
  to onedash_scheduler, onedash_queue, onedash_ingestor;

grant execute on function public.onedash_execution_status()
  to onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_schedule_due_jobs(integer, integer)
  to onedash_scheduler;
grant execute on function public.onedash_claim_jobs(
  text, text, integer, integer, text[]
) to onedash_queue;
grant execute on function public.onedash_extend_lease(uuid, uuid, integer)
  to onedash_queue;
grant execute on function public.onedash_release_job(uuid, uuid)
  to onedash_queue;
grant execute on function public.onedash_fail_job(uuid, uuid, text, boolean)
  to onedash_queue;
grant execute on function public.onedash_reap_expired_leases(integer)
  to onedash_scheduler, onedash_queue;
grant execute on function public.onedash_acknowledge_job(uuid, uuid)
  to onedash_queue, onedash_ingestor;
grant execute on function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  to onedash_ingestor;
grant execute on function public.onedash_record_heartbeat(
  text, text, text, jsonb
) to onedash_scheduler, onedash_queue;
grant execute on function public.onedash_queue_metrics()
  to onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_cleanup_stale_heartbeats(integer)
  to onedash_scheduler, onedash_queue;

-- Explicitly remove the PostgreSQL default PUBLIC EXECUTE from every Phase 4B
-- helper. The restrictions on the execution functions are repeated here so a
-- partially applied migration cannot leave them callable by PUBLIC.
revoke all on function public.onedash_is_fixture_hostname(text) from public;
revoke all on function public.onedash_require_supported_region(text) from public;
revoke all on function public.onedash_dead_letter_monitor_jobs(uuid, text)
  from public;
revoke all on function public.onedash_guard_schedule_write() from public;
revoke all on function public.onedash_guard_check_jobs_insert() from public;
revoke all on function public.onedash_bind_allowlist_url() from public;
revoke all on function public.onedash_monitor_authorization_change() from public;
revoke all on function public.onedash_allowlist_revocation() from public;
revoke all on function public.onedash_validate_heartbeat_details(text, jsonb)
  from public;
revoke all on function public.onedash_guard_heartbeat_details() from public;
revoke all on function public.onedash_cleanup_stale_heartbeats(integer)
  from public;
revoke all on function public.onedash_validate_result_payload(jsonb) from public;
revoke all on function public.onedash_schedule_due_jobs(integer, integer)
  from public;
revoke all on function public.onedash_claim_jobs(text, text, integer, integer, text[])
  from public;
revoke all on function public.onedash_extend_lease(uuid, uuid, integer)
  from public;
revoke all on function public.onedash_release_job(uuid, uuid) from public;
revoke all on function public.onedash_fail_job(uuid, uuid, text, boolean)
  from public;
revoke all on function public.onedash_reap_expired_leases(integer) from public;
revoke all on function public.onedash_acknowledge_job(uuid, uuid) from public;
revoke all on function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  from public;
revoke all on function public.onedash_record_heartbeat(text, text, text, jsonb)
  from public;

-- ------------------------------------------------------------
-- service_role non-DML privilege removal and default privileges
-- ------------------------------------------------------------

revoke truncate, references, trigger on table
  public.check_jobs,
  public.service_heartbeats,
  public.monitor_execution_settings,
  public.monitor_execution_allowlist,
  public.supported_regions
  from service_role;

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on table public.check_jobs, public.service_heartbeats, public.monitor_execution_settings, public.monitor_execution_allowlist, public.supported_regions from service_role';
  end if;
end $$;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from service_role;

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute
      'alter default privileges for role postgres in schema public revoke maintain on tables from service_role';
  end if;
end $$;

comment on table public.check_jobs is
  'Durable Phase 4B job queue. Direct DML is denied to application roles. service_role has no TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN privilege; jobs are managed only through restricted functions.';
comment on table public.service_heartbeats is
  'Internal heartbeat rows with a strict flat schema and bounded concurrency. service_role has no TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN privilege.';
comment on table public.monitor_execution_allowlist is
  'Operator-managed fixture authorization bound to the exact monitor URL. Removing a row or changing the monitor URL dead-letters pending jobs.';
