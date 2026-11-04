-- ============================================================
-- Phase 4B: scheduler, durable queue, worker permissions, ingestion
-- ============================================================
-- This migration adds the data-plane foundation only. It does NOT activate
-- customer monitoring. The execution gate is disabled by default, and both the
-- scheduler and the worker refuse to operate in "customer" mode in Phase 4B.
--
-- Queue technology decision: PostgreSQL job table with safe transactional
-- claiming. Supabase Queues (PGMQ) 1.5.1 is available in the local Postgres 17
-- image but was not installed. PGMQ provides durable messages and a visibility
-- timeout, but it has no built-in idempotency-key dedupe, maximum-attempt
-- policy, or exponential-backoff scheduling. Those are explicit Phase 4B
-- requirements, so a dedicated table with unique constraints and restricted
-- SECURITY DEFINER functions is simpler and more auditable.
--
-- Permission model:
--   * onedash_scheduler  - schedule due fixture jobs, reap expired leases,
--                          heartbeat, read aggregate metrics.
--   * onedash_queue      - claim/extend/release/retry jobs, heartbeat, read
--                          aggregate metrics. No direct application-table access.
--   * onedash_ingestor   - ingest validated results and complete the matching
--                          job atomically. No direct application-table access.
--   * onedash_worker     - deprecated legacy role. All grants and policies are
--                          removed. It is retained only so old deployments do
--                          not fail while they are migrated.
--   * checker process    - no database role at all. It receives only a minimal
--                          check configuration in memory.
--
-- Every SECURITY DEFINER function below has a fixed empty search_path and is
-- executable only by the role that needs it. Direct table access is denied.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'check_job_status') then
    create type public.check_job_status as enum (
      'pending', 'leased', 'completed', 'dead_letter'
    );
  end if;
end $$;

-- ------------------------------------------------------------
-- Data-plane roles
-- ------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'onedash_scheduler') then
    execute 'create role onedash_scheduler nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'onedash_queue') then
    execute 'create role onedash_queue nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'onedash_ingestor') then
    execute 'create role onedash_ingestor nologin';
  end if;
end $$;

comment on role onedash_scheduler is
  'Phase 4B scheduler group role. NOLOGIN. Executes only scheduler functions.';
comment on role onedash_queue is
  'Phase 4B queue group role. NOLOGIN. Claims and manages jobs through restricted functions.';
comment on role onedash_ingestor is
  'Phase 4B result ingestor group role. NOLOGIN. Stores results and completes jobs through one restricted function.';

-- ------------------------------------------------------------
-- Execution gate (disabled by default)
-- ------------------------------------------------------------

create table public.monitor_execution_settings (
  singleton          boolean primary key default true,
  execution_enabled  boolean not null default false,
  mode               text not null default 'disabled',
  reason             text not null default
    'Phase 4B: customer execution is locked until production egress isolation is independently verified.',
  egress_verified_at timestamptz,
  egress_verified_by text,
  updated_at         timestamptz not null default now(),
  constraint monitor_execution_settings_singleton_check check (singleton),
  constraint monitor_execution_settings_mode_check check (
    mode in ('disabled', 'fixtures', 'customer')
  ),
  constraint monitor_execution_settings_enabled_check check (
    execution_enabled = (mode <> 'disabled')
  ),
  constraint monitor_execution_settings_customer_attestation_check check (
    mode <> 'customer'
    or (
      egress_verified_at is not null
      and egress_verified_by is not null
      and char_length(egress_verified_by) between 1 and 200
    )
  ),
  constraint monitor_execution_settings_reason_check check (
    char_length(reason) between 1 and 500
  )
);

insert into public.monitor_execution_settings (
  singleton, execution_enabled, mode, reason
)
values (
  true,
  false,
  'disabled',
  'Phase 4B: customer execution is locked until production egress isolation is independently verified.'
)
on conflict (singleton) do nothing;

alter table public.monitor_execution_settings enable row level security;

drop trigger if exists monitor_execution_settings_set_updated_at
  on public.monitor_execution_settings;
create trigger monitor_execution_settings_set_updated_at
  before update on public.monitor_execution_settings
  for each row execute function public.set_updated_at();

comment on table public.monitor_execution_settings is
  'Singleton execution gate. Disabled by default. Only an operator with direct database access may change it; anon/authenticated have no grants or policies.';
comment on column public.monitor_execution_settings.mode is
  'disabled = no scheduling; fixtures = only allowlisted local test monitors; customer = not implemented in Phase 4B.';

-- ------------------------------------------------------------
-- Fixture allowlist (operator-managed, not application-accessible)
-- ------------------------------------------------------------

create table public.monitor_execution_allowlist (
  monitor_id      uuid primary key,
  organization_id uuid not null,
  reason          text not null default 'local fixture',
  created_at      timestamptz not null default now(),
  constraint monitor_execution_allowlist_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint monitor_execution_allowlist_reason_check check (
    char_length(reason) between 1 and 200
  )
);

create index monitor_execution_allowlist_org_idx
  on public.monitor_execution_allowlist (organization_id);

alter table public.monitor_execution_allowlist enable row level security;

comment on table public.monitor_execution_allowlist is
  'Operator-managed list of monitors that may be scheduled while the execution gate is in fixtures mode. The application has no grants or policies. This is not a customer activation mechanism.';

-- ------------------------------------------------------------
-- Durable job queue
-- ------------------------------------------------------------

create table public.check_jobs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  monitor_id          uuid not null,
  region              text not null,
  -- Logical scheduled slot (the schedule's due time, unjittered).
  scheduled_for       timestamptz not null,
  -- Earliest time a worker may claim this job (scheduled_for + jitter).
  available_at        timestamptz not null,
  idempotency_key     text not null,
  status              public.check_job_status not null default 'pending',
  attempts            integer not null default 0,
  max_attempts        integer not null default 5,
  lease_owner         text,
  lease_token         uuid,
  lease_expires_at    timestamptz,
  last_error_class    text,
  lease_expired_count integer not null default 0,
  result_id           uuid references public.check_results (id) on delete set null,
  completed_at        timestamptz,
  dead_letter_at      timestamptz,
  last_failure_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint check_jobs_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint check_jobs_idempotency_key_key unique (idempotency_key),
  constraint check_jobs_monitor_region_scheduled_key unique (
    monitor_id, region, scheduled_for
  ),
  constraint check_jobs_region_check check (
    char_length(region) between 2 and 32
    and region ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint check_jobs_idempotency_key_check check (
    char_length(idempotency_key) between 1 and 200
  ),
  constraint check_jobs_attempts_check check (attempts between 0 and 10),
  constraint check_jobs_max_attempts_check check (max_attempts between 1 and 10),
  constraint check_jobs_attempts_max_check check (attempts <= max_attempts),
  constraint check_jobs_lease_check check (
    (
      status = 'leased'
      and lease_owner is not null
      and lease_token is not null
      and lease_expires_at is not null
    )
    or (
      status <> 'leased'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
    )
  ),
  constraint check_jobs_completed_check check (
    (status = 'completed') = (completed_at is not null)
  ),
  constraint check_jobs_dead_letter_check check (
    (status = 'dead_letter') = (dead_letter_at is not null)
  ),
  constraint check_jobs_last_error_class_check check (
    last_error_class is null
    or last_error_class in (
      'internal_error',
      'timeout',
      'worker_error',
      'worker_shutdown',
      'lease_expired',
      'blocked_target'
    )
  ),
  constraint check_jobs_lease_expired_count_check check (
    lease_expired_count >= 0
  )
);

create index check_jobs_claim_idx
  on public.check_jobs (region, available_at, id)
  where status = 'pending';

create index check_jobs_lease_idx
  on public.check_jobs (lease_expires_at)
  where status = 'leased';

create index check_jobs_monitor_idx
  on public.check_jobs (monitor_id, scheduled_for desc);

create index check_jobs_status_idx
  on public.check_jobs (status, updated_at desc);

alter table public.check_jobs enable row level security;

drop trigger if exists check_jobs_set_updated_at on public.check_jobs;
create trigger check_jobs_set_updated_at
  before update on public.check_jobs
  for each row execute function public.set_updated_at();

comment on table public.check_jobs is
  'Durable Phase 4B job queue. Unique idempotency keys and (monitor, region, scheduled slot) prevent duplicate logical checks. Workers claim rows with FOR UPDATE SKIP LOCKED through a restricted function.';
comment on column public.check_jobs.scheduled_for is
  'Logical due slot in UTC. Used as the check_results.scheduled_at value and as part of the idempotency key.';
comment on column public.check_jobs.available_at is
  'scheduled_for plus small deterministic jitter. Workers cannot claim before this time.';
comment on column public.check_jobs.lease_token is
  'Random per-claim ownership token. A stale worker cannot extend, fail, or ingest after another worker reclaims the job.';

-- ------------------------------------------------------------
-- Service heartbeats (internal metrics only)
-- ------------------------------------------------------------

create table public.service_heartbeats (
  component    text not null,
  instance_id  text not null,
  region       text not null,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  details      jsonb not null default '{}'::jsonb,
  primary key (component, instance_id),
  constraint service_heartbeats_component_check check (
    component in ('scheduler', 'worker')
  ),
  constraint service_heartbeats_instance_check check (
    char_length(instance_id) between 1 and 100
  ),
  constraint service_heartbeats_region_check check (
    char_length(region) between 2 and 32
    and region ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint service_heartbeats_details_check check (
    jsonb_typeof(details) = 'object'
    and pg_column_size(details) <= 2048
    and not (
      details ?| array[
        'url', 'hostname', 'secret', 'token', 'password', 'authorization',
        'api_key', 'email', 'monitor_url', 'organization_id', 'monitor_id'
      ]
    )
  )
);

create index service_heartbeats_seen_idx
  on public.service_heartbeats (component, last_seen_at desc);

alter table public.service_heartbeats enable row level security;

comment on table public.service_heartbeats is
  'Internal scheduler/worker heartbeat rows. No customer URLs, secrets, monitor IDs, or organization IDs are allowed in details.';

-- ------------------------------------------------------------
-- Remove the old broad worker permissions
-- ------------------------------------------------------------
-- The Phase 2 worker role could read monitors, schedules, incidents, monitor
-- state, check results, request secrets, alert metadata, and alert secrets.
-- That is broader than any Phase 4B component needs. New components use the
-- restricted roles above. Keep the role itself for a safe deployment
-- transition, but remove every privilege and policy.

drop policy if exists "worker can read monitors" on public.monitors;
drop policy if exists "worker can read monitor request secrets" on public.monitor_request_secrets;
drop policy if exists "worker can read monitor schedules" on public.monitor_schedules;
drop policy if exists "worker can update monitor schedules" on public.monitor_schedules;
drop policy if exists "worker can read incidents" on public.incidents;
drop policy if exists "worker can create incidents" on public.incidents;
drop policy if exists "worker can update incidents" on public.incidents;
drop policy if exists "worker can read incident updates" on public.incident_updates;
drop policy if exists "worker can add incident updates" on public.incident_updates;
drop policy if exists "worker can read monitor state" on public.monitor_state;
drop policy if exists "worker can create monitor state" on public.monitor_state;
drop policy if exists "worker can update monitor state" on public.monitor_state;
drop policy if exists "worker can read check results" on public.check_results;
drop policy if exists "worker can insert check results" on public.check_results;
drop policy if exists "worker can read alert channels" on public.alert_channels;
drop policy if exists "worker can read alert channel secrets" on public.alert_channel_secrets;
drop policy if exists "worker can read monitor alert links" on public.monitor_alert_channels;
drop policy if exists "worker can read alert deliveries" on public.alert_deliveries;
drop policy if exists "worker can create alert deliveries" on public.alert_deliveries;
drop policy if exists "worker can update alert deliveries" on public.alert_deliveries;

revoke all on all tables in schema public from onedash_worker;
revoke all on all sequences in schema public from onedash_worker;
revoke all on all functions in schema public from onedash_worker;
revoke usage on schema public from onedash_worker;

comment on role onedash_worker is
  'Deprecated Phase 2 broad worker role. NOLOGIN. All direct table, sequence, function, and schema grants and policies have been revoked; PUBLIC schema USAGE still applies. Use onedash_scheduler, onedash_queue, or onedash_ingestor.';

-- ------------------------------------------------------------
-- New tables are not directly accessible to application or API roles
-- ------------------------------------------------------------

revoke all on table public.check_jobs from public;
revoke all on table public.service_heartbeats from public;
revoke all on table public.monitor_execution_settings from public;
revoke all on table public.monitor_execution_allowlist from public;

revoke all on table public.check_jobs from anon, authenticated;
revoke all on table public.service_heartbeats from anon, authenticated;
revoke all on table public.monitor_execution_settings from anon, authenticated;
revoke all on table public.monitor_execution_allowlist from anon, authenticated;

-- ============================================================
-- Internal helpers
-- ============================================================

create or replace function public.onedash_job_backoff_seconds(p_attempts integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(
    300,
    (
      5 * pg_catalog.power(
        2.0,
        greatest(0, least(coalesce(p_attempts, 1) - 1, 6))
      )
    )::integer
  );
$$;

comment on function public.onedash_job_backoff_seconds(integer) is
  'Deterministic retry backoff: 5, 10, 20, 40, 80, 160, then capped at 300 seconds.';

create or replace function public.onedash_validate_result_payload(p_result jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
  v_status text;
  v_error_class text;
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

  if p_result ? 'error_message' and p_result->>'error_message' is not null
     and char_length(p_result->>'error_message') > 1000 then
    raise exception 'error_message is too long' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.onedash_job_backoff_seconds(integer) from public;
revoke all on function public.onedash_validate_result_payload(jsonb) from public;

-- ============================================================
-- Execution status (safe, non-secret)
-- ============================================================

create or replace function public.onedash_execution_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select pg_catalog.jsonb_build_object(
        'enabled', s.execution_enabled,
        'mode', s.mode,
        'reason', s.reason,
        'egress_verified_at', s.egress_verified_at,
        'egress_verified_by', s.egress_verified_by
      )
      from public.monitor_execution_settings s
      where s.singleton
    ),
    pg_catalog.jsonb_build_object(
      'enabled', false,
      'mode', 'disabled',
      'reason', 'execution settings row is missing',
      'egress_verified_at', null,
      'egress_verified_by', null
    )
  );
$$;

comment on function public.onedash_execution_status() is
  'Returns the non-secret execution gate state. The gate is disabled by default and customer mode is refused by Phase 4B components.';

revoke all on function public.onedash_execution_status() from public;

-- ============================================================
-- Scheduler: create unique jobs for due, allowlisted, active monitors
-- ============================================================

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

  -- Customer execution is deliberately not implemented in Phase 4B. Refusing
  -- here prevents a backlog of customer jobs that no worker is allowed to run.
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

    -- If the scheduler was down for a long time, skip missed slots instead of
    -- creating one job per missed interval. At most one catch-up job is made.
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
  'Creates at most one unique job per due monitor slot. Uses row locks and unique idempotency keys so multiple schedulers are safe. Skips missed downtime slots to avoid a backlog. Only runs in fixtures mode with an allowlisted monitor.';

revoke all on function public.onedash_schedule_due_jobs(integer, integer) from public;

-- ============================================================
-- Queue: claim jobs safely with a lease and ownership token
-- ============================================================

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

  -- Fixtures mode requires an explicit host allowlist from the worker. This is
  -- a second lock on top of the database allowlist, not a proof of network
  -- isolation. It prevents a misconfigured fixture worker from claiming a
  -- customer URL.
  if p_allowed_hosts is null
     or cardinality(p_allowed_hosts) = 0
     or cardinality(p_allowed_hosts) > 20 then
    return pg_catalog.jsonb_build_object(
      'jobs', '[]'::jsonb,
      'execution_mode', v_exec.mode,
      'reason', 'fixture host allowlist is required'
    );
  end if;

  select pg_catalog.array_agg(pg_catalog.lower(host))
  into v_hosts
  from pg_catalog.unnest(p_allowed_hosts) as hosts(host);

  if exists (
    select 1
    from pg_catalog.unnest(v_hosts) as hosts(host)
    where host is null
       or host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
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
  'Claims pending fixture jobs for one region using FOR UPDATE SKIP LOCKED, increments the attempt count, and returns a per-claim lease token plus the minimum checker configuration. It never returns request secrets, alert secrets, or organization/user data.';

revoke all on function public.onedash_claim_jobs(text, text, integer, integer, text[]) from public;

-- ============================================================
-- Queue: lease extension, release, retry, dead-letter, recovery, ack
-- ============================================================

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
  'Extends a live lease only when the caller still owns the job. An expired lease cannot be revived.';

revoke all on function public.onedash_extend_lease(uuid, uuid, integer)
  from public, anon, authenticated;

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
  returning status into v_status;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'lease_mismatch');
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

comment on function public.onedash_release_job(uuid, uuid) is
  'Releases a job after a graceful worker shutdown. It becomes pending immediately unless the attempt limit has been reached, in which case it becomes terminal.';

revoke all on function public.onedash_release_job(uuid, uuid)
  from public, anon, authenticated;

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
     or v_job.lease_token is distinct from p_lease_token then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'lease_mismatch');
  end if;

  if not v_retryable or v_job.attempts >= v_job.max_attempts then
    update public.check_jobs
    set status = 'dead_letter',
        dead_letter_at = v_now,
        completed_at = null,
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
  'Marks a job for exponential-backoff retry or terminal dead-letter. The attempt count is incremented at claim time; this function never silently discards a job.';

revoke all on function public.onedash_fail_job(uuid, uuid, text, boolean)
  from public, anon, authenticated;

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
  'Recovers jobs whose worker disappeared. Expired leases become pending with backoff, or terminal if the attempt limit was reached.';

revoke all on function public.onedash_reap_expired_leases(integer)
  from public, anon, authenticated;

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
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'job_status', 'completed',
      'result_id', v_job.result_id
    );
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'lease_mismatch');
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
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_class = null,
      updated_at = v_now
  where id = p_job_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'job_status', 'completed',
    'result_id', v_result_id
  );
end;
$$;

comment on function public.onedash_acknowledge_job(uuid, uuid) is
  'Safely acknowledges a completed job only if a matching check result already exists. It cannot be used to discard a job without a result.';

revoke all on function public.onedash_acknowledge_job(uuid, uuid)
  from public, anon, authenticated;

-- ============================================================
-- Result ingestor: validate, store idempotently, update state, complete job
-- ============================================================

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

  -- A worker may retry ingestion after the first transaction committed but
  -- before it observed the response. Return the existing result without
  -- writing a duplicate or regressing monitor state.
  if v_job.status = 'completed' then
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
     or v_job.lease_token is distinct from p_lease_token then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'lease_mismatch');
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

  v_monitor_status := case
    when v_status = 'up' then 'up'::public.monitor_status
    else 'down'::public.monitor_status
  end;

  -- The job row, not the payload, supplies organization_id, monitor_id,
  -- region, scheduled slot, and idempotency key. A caller cannot redirect a
  -- result to another monitor or tenant.
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
    -- Upsert is atomic under concurrent ingestion. The WHERE clause prevents
    -- a late, older result from overwriting newer monitor state.
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
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_class = null,
      updated_at = v_now
  where id = v_job.id
    and status = 'leased'
    and lease_token = p_lease_token;

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
  'Stores one checker result using the job-supplied tenant/monitor identity, updates monitor_state only for newer results, and completes the job in the same transaction. The payload cannot select a different monitor. Fixture-mode results are synthetic test data. No incidents or notifications are created.';

revoke all on function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  from public, anon, authenticated;

-- ============================================================
-- Heartbeat and aggregate metrics (no customer URLs or identifiers)
-- ============================================================

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
  if p_details is null or pg_catalog.jsonb_typeof(p_details) <> 'object' then
    raise exception 'heartbeat details must be a JSON object'
      using errcode = '22023';
  end if;
  if pg_catalog.pg_column_size(p_details) > 2048 then
    raise exception 'heartbeat details are too large' using errcode = '22023';
  end if;
  if p_details ?| array[
       'url', 'hostname', 'secret', 'token', 'password', 'authorization',
       'api_key', 'email', 'monitor_url', 'organization_id', 'monitor_id'
     ] then
    raise exception 'heartbeat details contain a forbidden field'
      using errcode = '22023';
  end if;

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
  'Records an internal scheduler/worker heartbeat. Details are allowlisted by the table constraint and reject URLs, secrets, monitor IDs, and organization IDs.';

revoke all on function public.onedash_record_heartbeat(text, text, text, jsonb)
  from public, anon, authenticated;

create or replace function public.onedash_queue_metrics()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with n as (
    select pg_catalog.now() as now
  ),
  jobs as (
    select
      count(*) filter (where status = 'pending')::int as queue_depth,
      count(*) filter (where status = 'leased')::int as leased_jobs,
      count(*) filter (where status = 'completed')::int as completed_jobs,
      count(*) filter (where status = 'dead_letter')::int as dead_letter_jobs,
      count(*) filter (where attempts > 1)::int as retried_jobs,
      coalesce(sum(lease_expired_count), 0)::int as expired_leases,
      coalesce(
        greatest(
          0,
          extract(
            epoch from (select now from n) - min(available_at)
              filter (where status = 'pending')
          )
        )::int,
        0
      ) as oldest_job_age_seconds,
      count(*) filter (
        where status = 'completed'
          and completed_at > (select now from n) - interval '1 hour'
      )::int as completed_jobs_last_hour,
      count(*) filter (
        where status = 'dead_letter'
          and dead_letter_at > (select now from n) - interval '1 hour'
      )::int as failed_jobs_last_hour
    from public.check_jobs
  ),
  schedules as (
    select
      coalesce(
        greatest(
          0,
          extract(
            epoch from (select now from n) - min(s.next_run_at)
              filter (where s.next_run_at <= (select now from n))
          )
        )::int,
        0
      ) as scheduler_delay_seconds
    from public.monitor_schedules s
    join public.monitors m
      on m.id = s.monitor_id
     and m.organization_id = s.organization_id
    where m.is_active
  ),
  heartbeats as (
    select
      extract(
        epoch from (select now from n) - max(last_seen_at)
          filter (where component = 'scheduler')
      )::int as scheduler_heartbeat_age_seconds,
      extract(
        epoch from (select now from n) - max(last_seen_at)
          filter (where component = 'worker')
      )::int as worker_heartbeat_age_seconds,
      coalesce(
        sum(
          case
            when component = 'worker'
              and last_seen_at > (select now from n) - interval '2 minutes'
              and (details->>'concurrency') ~ '^[0-9]+$'
              then (details->>'concurrency')::int
            else 0
          end
        ),
        0
      )::int as worker_concurrency
    from public.service_heartbeats
  ),
  results as (
    select
      count(*) filter (
        where error_class = 'timeout'
          and checked_at > (select now from n) - interval '1 hour'
      )::int as timeout_results_last_hour,
      coalesce(
        avg(total_ms) filter (
          where checked_at > (select now from n) - interval '1 hour'
        )::int,
        0
      ) as check_duration_ms_avg_last_hour
    from public.check_results
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', (select now from n),
    'queue_depth', jobs.queue_depth,
    'leased_jobs', jobs.leased_jobs,
    'completed_jobs', jobs.completed_jobs,
    'completed_jobs_last_hour', jobs.completed_jobs_last_hour,
    'failed_jobs', jobs.dead_letter_jobs,
    'failed_jobs_last_hour', jobs.failed_jobs_last_hour,
    'retried_jobs', jobs.retried_jobs,
    'expired_leases', jobs.expired_leases,
    'oldest_job_age_seconds', jobs.oldest_job_age_seconds,
    'scheduler_delay_seconds', schedules.scheduler_delay_seconds,
    'scheduler_heartbeat_age_seconds', heartbeats.scheduler_heartbeat_age_seconds,
    'worker_heartbeat_age_seconds', heartbeats.worker_heartbeat_age_seconds,
    'worker_concurrency', heartbeats.worker_concurrency,
    'timeout_results_last_hour', results.timeout_results_last_hour,
    'check_duration_ms_avg_last_hour', results.check_duration_ms_avg_last_hour
  )
  from jobs, schedules, heartbeats, results;
$$;

comment on function public.onedash_queue_metrics() is
  'Aggregate queue, scheduler, worker, timeout, and check-duration metrics. No customer URL, monitor ID, organization ID, or secret is returned.';

revoke all on function public.onedash_queue_metrics()
  from public, anon, authenticated;

-- ============================================================
-- Function grants
-- ============================================================

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

-- Ensure the deprecated role did not regain access through PostgreSQL's
-- default EXECUTE grant to PUBLIC on newly created functions.
revoke all on all functions in schema public from onedash_worker;

comment on function public.onedash_schedule_due_jobs(integer, integer) is
  'Scheduler entry point. The execution gate is disabled by default; fixtures mode requires a monitor_execution_allowlist row; customer mode is refused in Phase 4B.';
comment on function public.onedash_claim_jobs(text, text, integer, integer, text[]) is
  'Queue entry point. It returns only the minimum checker configuration. The checker process itself never receives a database credential.';
comment on function public.onedash_ingest_check_result(uuid, uuid, jsonb) is
  'Ingestor entry point. The job row is the sole authority for tenant/monitor identity; the payload cannot override it.';
