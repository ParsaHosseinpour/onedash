-- ============================================================
-- Phase 4C.0 residual security and correctness hardening
-- ============================================================
-- Forward-only hardening for the Phase 4B scheduler/queue/ingestion
-- foundation. This migration does NOT enable customer monitoring. The execution
-- gate remains disabled by default and customer mode is still refused by both
-- components.
--
-- Findings addressed:
--   A. Revocation now dead-letters pending AND leased jobs with every lease and
--      completion field cleared. Ingestion revalidates monitor existence,
--      activity, current URL, allowlist, execution gate, lease token, and lease
--      expiry before writing a result. It accepts or rejects atomically and
--      returns a structured reason.
--   B. The five-schedule and ten-pending-plus-leased-job caps are serialized
--      per monitor with transaction-scoped advisory locks. Schedules and jobs
--      use separate lock namespaces so one monitor's schedule insert cannot
--      block another monitor's job insert.
--   C. Queue metrics tolerate malformed legacy heartbeat/queue values, clamp
--      every cast and aggregate to the integer range, and never fail because a
--      single legacy row bypassed validation.
--   D. Default PUBLIC EXECUTE is removed for future functions created by the
--      postgres and onedash_function_owner roles. The migration also attempts
--      the same for supabase_admin and reports the privilege limitation instead
--      of failing the migration.
--   E. Stale-heartbeat cleanup is scheduler-only, runs with function-level
--      statement/lock timeouts, deletes in bounded batches, and never selects
--      active heartbeats.
--   F. Worker ingestion-rejection classification is handled in TypeScript; the
--      database side exposes a retryable flag and fixed reason vocabulary.
--
-- Canonical lock order for authorization-sensitive work:
--
--     monitor row -> execution-gate row -> allowlist authorization -> job row
--
-- Revocation triggers that already hold a monitor or gate row must not acquire
-- a job row before the corresponding authorization check. Job revocation scans
-- are ordered by id so monitor and gate revocations cannot deadlock each other.
-- Ingestion reads the allowlist while holding the monitor lock instead of
-- taking a separate allowlist row lock; allowlist writes take the monitor lock
-- first, which serializes them with ingestion without a lock-order inversion.
-- ============================================================

-- ------------------------------------------------------------
-- Finding B: concurrency-safe per-monitor caps
-- ------------------------------------------------------------
-- A plain count-then-insert trigger lets two concurrent transactions both see
-- the last free slot. These transaction-scoped advisory locks serialize only
-- inserts for the same monitor. The lock is re-entrant inside one transaction,
-- so a multi-row INSERT still evaluates the cap once per row against the rows
-- already inserted by that statement.
--
-- The prefixes are intentionally distinct: schedule and job inserts for the
-- same monitor use different lock namespaces, and different monitors never
-- serialize against each other.

create or replace function public.onedash_guard_schedule_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_schedule_count integer;
begin
  -- Region validity is enforced by the supported_regions foreign key. Keeping
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
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'onedash-schedule-cap:' || new.monitor_id::text,
        0
      )
    );

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
  'Enforces the five-schedule-per-monitor limit under a per-monitor advisory lock (namespace onedash-schedule-cap) and prevents ordinary users from modifying scheduler-owned columns. Region validity is enforced by the supported_regions foreign key.';

revoke all on function public.onedash_guard_schedule_write() from public;

create or replace function public.onedash_guard_check_jobs_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pending integer;
begin
  -- Region validity is enforced by check_jobs_region_fk.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'onedash-job-cap:' || new.monitor_id::text,
      0
    )
  );

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
  'Caps pending plus leased jobs per monitor at ten under a per-monitor advisory lock (namespace onedash-job-cap). Region validity is enforced by check_jobs_region_fk.';

revoke all on function public.onedash_guard_check_jobs_insert() from public;

-- ------------------------------------------------------------
-- Finding A: revocation clears pending and leased work
-- ------------------------------------------------------------
-- The old helper only dead-lettered pending jobs. A leased job survived a
-- monitor pause, URL change, or allowlist removal and could still be ingested
-- with its old token. The helper now terminates both non-terminal states and
-- clears every lease/completion field so no stale worker can complete the row.

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
  v_job_id uuid;
  v_updated integer := 0;
begin
  if p_monitor_id is null then
    return 0;
  end if;
  if p_error_class is null
     or p_error_class not in ('blocked_target', 'worker_shutdown') then
    raise exception 'unsupported dead-letter error class' using errcode = '22023';
  end if;

  -- Lock job rows in a stable order. This matters when a monitor revocation
  -- and a gate revocation run concurrently: both scan by id, so they cannot
  -- deadlock on an overlapping set of jobs.
  for v_job_id in
    select j.id
    from public.check_jobs j
    where j.monitor_id = p_monitor_id
      and j.status in ('pending', 'leased')
    order by j.id
    for update
  loop
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
    where id = v_job_id;

    v_updated := v_updated + 1;
  end loop;

  return v_updated;
end;
$$;

comment on function public.onedash_dead_letter_monitor_jobs(uuid, text) is
  'Terminally fails pending and leased jobs when authorization for a monitor is revoked. Clears all lease and completion ownership fields. Used for deactivation, URL changes, allowlist removal, and gate disable.';

revoke all on function public.onedash_dead_letter_monitor_jobs(uuid, text)
  from public;

create or replace function public.onedash_dead_letter_all_jobs(
  p_error_class text default 'blocked_target'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_job_id uuid;
  v_updated integer := 0;
begin
  if p_error_class is null
     or p_error_class not in ('blocked_target', 'worker_shutdown') then
    raise exception 'unsupported dead-letter error class' using errcode = '22023';
  end if;

  for v_job_id in
    select j.id
    from public.check_jobs j
    where j.status in ('pending', 'leased')
    order by j.id
    for update
  loop
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
    where id = v_job_id;

    v_updated := v_updated + 1;
  end loop;

  return v_updated;
end;
$$;

comment on function public.onedash_dead_letter_all_jobs(text) is
  'Terminally fails every pending and leased job when the execution gate leaves fixtures mode. Clears all lease and completion ownership fields.';

revoke all on function public.onedash_dead_letter_all_jobs(text) from public;

-- A gate transition away from enabled fixtures mode revokes all outstanding
-- work. This is deliberately an AFTER trigger: the settings row is already
-- locked by the operator UPDATE, and the helper then locks jobs in id order.
create or replace function public.onedash_execution_gate_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.execution_enabled
     and old.mode in ('fixtures', 'customer')
     and not (new.execution_enabled and new.mode = 'fixtures') then
    perform public.onedash_dead_letter_all_jobs('blocked_target');
  end if;

  return new;
end;
$$;

comment on function public.onedash_execution_gate_change() is
  'Dead-letters all pending and leased jobs when the execution gate stops being enabled fixtures mode.';

revoke all on function public.onedash_execution_gate_change() from public;

drop trigger if exists monitor_execution_settings_revoke_jobs
  on public.monitor_execution_settings;
create trigger monitor_execution_settings_revoke_jobs
  after update of execution_enabled, mode on public.monitor_execution_settings
  for each row execute function public.onedash_execution_gate_change();

-- Allowlist writes take an exclusive monitor row lock first. Ingestion holds the
-- same row in share mode while it reads the authorization row, so a concurrent
-- delete or URL rebind cannot race the authorization decision. FOR NO KEY UPDATE
-- is the weakest mode that conflicts with FOR SHARE; it still allows foreign-key
-- KEY SHARE checks on the monitor row.
create or replace function public.onedash_lock_allowlist_monitor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_monitor_id uuid;
begin
  if tg_op = 'DELETE' then
    v_monitor_id := old.monitor_id;
  else
    v_monitor_id := new.monitor_id;
  end if;

  perform 1
  from public.monitors m
  where m.id = v_monitor_id
  for no key update;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.onedash_lock_allowlist_monitor() is
  'Takes the monitor row lock (FOR NO KEY UPDATE) before an allowlist insert, update, or delete so allowlist changes serialize with ingestion authorization checks while still permitting foreign-key checks.';

revoke all on function public.onedash_lock_allowlist_monitor() from public;

drop trigger if exists monitor_execution_allowlist_lock_monitor
  on public.monitor_execution_allowlist;
create trigger monitor_execution_allowlist_lock_monitor
  before insert or update or delete on public.monitor_execution_allowlist
  for each row execute function public.onedash_lock_allowlist_monitor();

-- The URL-binding trigger previously read the monitor without a lock. A URL
-- update could therefore delete the allowlist row and then race a new insert
-- that still saw the old URL. FOR NO KEY UPDATE closes that window and matches
-- the allowlist monitor lock, avoiding a share-to-exclusive upgrade deadlock
-- between two concurrent allowlist writes for the same monitor.
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
    and m.organization_id = new.organization_id
  for no key update;

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
  'Requires the allowlist URL to equal the current monitor URL under a monitor row lock (FOR NO KEY UPDATE). This binds authorization to the exact destination and serializes with URL changes and ingestion authorization checks.';

revoke all on function public.onedash_bind_allowlist_url() from public;

-- ------------------------------------------------------------
-- Finding A: ingestion revalidates the full authorization state
-- ------------------------------------------------------------
-- The old function locked the job first and then read the monitor and
-- allowlist. A revocation could run between those reads, and a leased job that
-- was revoked could still be completed. The new order is:
--
--   1. pre-read the job identity without locking it;
--   2. share-lock the monitor row;
--   3. share-lock the execution gate row;
--   4. read the allowlist while the monitor is locked;
--   5. lock the job row last and revalidate token, expiry, and state.
--
-- All rejection paths return before any result or monitor-state write. Every
-- rejection includes a fixed reason and retryable=false so the worker can
-- classify it without parsing free text.

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
  v_pre_monitor_id uuid;
  v_pre_organization_id uuid;
  v_monitor public.monitors%rowtype;
  v_exec public.monitor_execution_settings%rowtype;
  v_allowlist_url text;
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

  -- Pre-read only the identity needed to choose the monitor lock. The job row
  -- itself is locked last, after monitor, gate, and allowlist checks.
  select j.monitor_id, j.organization_id
  into v_pre_monitor_id, v_pre_organization_id
  from public.check_jobs j
  where j.id = p_job_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'job_not_found', 'retryable', false
    );
  end if;

  select m.*
  into v_monitor
  from public.monitors m
  where m.id = v_pre_monitor_id
    and m.organization_id = v_pre_organization_id
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'monitor_not_found', 'retryable', false
    );
  end if;

  select s.*
  into v_exec
  from public.monitor_execution_settings s
  where s.singleton
  for share;

  if not found
     or not v_exec.execution_enabled
     or v_exec.mode <> 'fixtures' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'execution_disabled', 'retryable', false
    );
  end if;

  -- Read the allowlist under the monitor share lock. No separate allowlist row
  -- lock is needed: allowlist writes take the monitor lock first, so this read
  -- is serialized with every authorization change.
  select a.url
  into v_allowlist_url
  from public.monitor_execution_allowlist a
  where a.monitor_id = v_monitor.id
    and a.organization_id = v_monitor.organization_id;

  if not v_monitor.is_active
     or v_allowlist_url is null
     or v_allowlist_url is distinct from v_monitor.url then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'monitor_not_authorized', 'retryable', false
    );
  end if;

  select j.*
  into v_job
  from public.check_jobs j
  where j.id = p_job_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'job_not_found', 'retryable', false
    );
  end if;

  -- Defend against an operator rewriting the job identity between the
  -- pre-read and the job lock.
  if v_job.monitor_id is distinct from v_monitor.id
     or v_job.organization_id is distinct from v_monitor.organization_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'job_not_found', 'retryable', false
    );
  end if;

  -- now() is transaction start time. Re-read the wall clock after acquiring the
  -- job lock so a lease that expired while this call waited on a competing
  -- transaction cannot still be accepted.
  v_now := pg_catalog.clock_timestamp();

  if v_job.status = 'completed' then
    if v_job.completion_token is distinct from p_lease_token then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'lease_mismatch', 'retryable', false
      );
    end if;

    select r.id
    into v_result_id
    from public.check_results r
    where r.monitor_id = v_job.monitor_id
      and r.idempotency_key = v_job.idempotency_key;

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
      'reason', 'job_completed_without_result',
      'retryable', false
    );
  end if;

  if v_job.status <> 'leased'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'lease_mismatch_or_expired',
      'retryable', false
    );
  end if;

  v_expected_status_codes := v_monitor.expected_status_codes;

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
    select r.id
    into v_result_id
    from public.check_results r
    where r.monitor_id = v_job.monitor_id
      and r.idempotency_key = v_job.idempotency_key;

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
  'Revalidates monitor existence/activity/current URL, allowlist, execution gate, lease token, and expiry in canonical lock order before atomically storing one validated result. Rejections are structured JSON with a fixed reason and retryable=false.';

revoke all on function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  from public;

-- ------------------------------------------------------------
-- Finding C: metrics tolerant of malformed legacy rows
-- ------------------------------------------------------------

create or replace function public.onedash_safe_metric_bigint(
  p_value text,
  p_min bigint,
  p_max bigint
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then null
    when p_value !~ '^[0-9]{1,18}$' then null
    else least(greatest(p_value::bigint, p_min), p_max)
  end;
$$;

comment on function public.onedash_safe_metric_bigint(text, bigint, bigint) is
  'Parses a legacy numeric metric string only when it is 1-18 ASCII digits, then clamps it to the supplied bigint range. Returns null for malformed input so one legacy row cannot fail an aggregate.';

revoke all on function public.onedash_safe_metric_bigint(text, bigint, bigint)
  from public;

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
      least(count(*) filter (where status = 'pending'), 2147483647)::int
        as queue_depth,
      least(count(*) filter (where status = 'leased'), 2147483647)::int
        as leased_jobs,
      least(count(*) filter (where status = 'completed'), 2147483647)::int
        as completed_jobs,
      least(count(*) filter (where status = 'dead_letter'), 2147483647)::int
        as dead_letter_jobs,
      least(count(*) filter (where attempts > 1), 2147483647)::int
        as retried_jobs,
      least(coalesce(sum(lease_expired_count), 0), 2147483647)::int
        as expired_leases,
      case
        when min(available_at) filter (where status = 'pending') is null then 0
        else least(
          greatest(
            extract(
              epoch from (select now from n)
                - min(available_at) filter (where status = 'pending')
            )::bigint,
            0
          ),
          2147483647
        )::int
      end as oldest_job_age_seconds,
      least(
        count(*) filter (
          where status = 'completed'
            and completed_at > (select now from n) - interval '1 hour'
        ),
        2147483647
      )::int as completed_jobs_last_hour,
      least(
        count(*) filter (
          where status = 'dead_letter'
            and dead_letter_at > (select now from n) - interval '1 hour'
        ),
        2147483647
      )::int as failed_jobs_last_hour
    from public.check_jobs
  ),
  schedules as (
    select
      case
        when min(s.next_run_at) filter (
          where s.next_run_at <= (select now from n)
        ) is null then 0
        else least(
          greatest(
            extract(
              epoch from (select now from n)
                - min(s.next_run_at) filter (
                    where s.next_run_at <= (select now from n)
                  )
            )::bigint,
            0
          ),
          2147483647
        )::int
      end as scheduler_delay_seconds
    from public.monitor_schedules s
    join public.monitors m
      on m.id = s.monitor_id
     and m.organization_id = s.organization_id
    where m.is_active
  ),
  heartbeats as (
    select
      case
        when max(last_seen_at) filter (where component = 'scheduler') is null
          then null
        else least(
          greatest(
            extract(
              epoch from (select now from n)
                - max(last_seen_at) filter (where component = 'scheduler')
            )::bigint,
            0
          ),
          2147483647
        )::int
      end as scheduler_heartbeat_age_seconds,
      case
        when max(last_seen_at) filter (where component = 'worker') is null
          then null
        else least(
          greatest(
            extract(
              epoch from (select now from n)
                - max(last_seen_at) filter (where component = 'worker')
            )::bigint,
            0
          ),
          2147483647
        )::int
      end as worker_heartbeat_age_seconds,
      least(
        coalesce(
          sum(
            case
              when component = 'worker'
                and last_seen_at > (select now from n) - interval '2 minutes'
                then public.onedash_safe_metric_bigint(
                  details->>'concurrency',
                  0,
                  10
                )
              else 0
            end
          ),
          0
        ),
        2147483647
      )::int as worker_concurrency
    from public.service_heartbeats
  ),
  results as (
    select
      least(
        count(*) filter (
          where error_class = 'timeout'
            and checked_at > (select now from n) - interval '1 hour'
        ),
        2147483647
      )::int as timeout_results_last_hour,
      least(
        greatest(
          coalesce(
            avg(total_ms) filter (
              where checked_at > (select now from n) - interval '1 hour'
            ),
            0
          ),
          0
        ),
        2147483647
      )::int as check_duration_ms_avg_last_hour
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
  'Aggregate queue, scheduler, worker, timeout, and check-duration metrics. Every cast and aggregate is clamped to the integer range; malformed legacy concurrency values are ignored instead of failing the whole query.';

revoke all on function public.onedash_queue_metrics()
  from public;

-- ------------------------------------------------------------
-- Finding E: bounded scheduler-only heartbeat cleanup
-- ------------------------------------------------------------

create or replace function public.onedash_cleanup_stale_heartbeats(
  p_older_than_seconds integer default 86400
)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
  v_deleted integer := 0;
  v_batch integer;
  v_batches integer := 0;
  v_cutoff timestamptz;
begin
  if p_older_than_seconds is null
     or p_older_than_seconds < 60
     or p_older_than_seconds > 31536000 then
    raise exception 'heartbeat retention must be between 60 and 31536000 seconds'
      using errcode = '22023';
  end if;

  v_cutoff := pg_catalog.now()
    - pg_catalog.make_interval(secs => p_older_than_seconds);

  -- Delete at most 1,000 rows per statement and 10,000 per call. The next
  -- hourly scheduler tick continues a larger backlog. Active heartbeats have
  -- last_seen_at >= cutoff and are never selected.
  loop
    delete from public.service_heartbeats h
    where h.ctid in (
      select s.ctid
      from public.service_heartbeats s
      where s.last_seen_at < v_cutoff
      order by s.last_seen_at, s.component, s.instance_id
      limit 1000
      for update skip locked
    );

    get diagnostics v_batch = row_count;
    v_deleted := v_deleted + v_batch;
    v_batches := v_batches + 1;

    exit when v_batch < 1000 or v_batches >= 10;
  end loop;

  return v_deleted;
end;
$$;

comment on function public.onedash_cleanup_stale_heartbeats(integer) is
  'Scheduler-only maintenance. Deletes stale heartbeat rows in bounded batches under function-level statement and lock timeouts. Active heartbeats are never selected.';

revoke all on function public.onedash_cleanup_stale_heartbeats(integer)
  from public, onedash_queue;
grant execute on function public.onedash_cleanup_stale_heartbeats(integer)
  to onedash_scheduler;

-- ------------------------------------------------------------
-- Finding D: default function-execute hardening
-- ------------------------------------------------------------
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. The Phase 4B
-- migration removed that default for objects created by postgres. Future
-- SECURITY DEFINER functions can also be created by the dedicated function
-- owner, so its default must be hardened too.

alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres
  revoke execute on functions from anon, authenticated, service_role;

alter default privileges for role onedash_function_owner
  revoke execute on functions from public;
alter default privileges for role onedash_function_owner
  revoke execute on functions from anon, authenticated, service_role;

-- supabase_admin is a superuser in the local Supabase image and the migration
-- role is not a member. PostgreSQL therefore refuses both ALTER DEFAULT
-- PRIVILEGES FOR ROLE supabase_admin and REVOKE on functions owned by it. Do not
-- fail the migration: report the limitation so an operator can run the same
-- statements in a superuser-owned migration or maintenance window.
do $$
declare
  v_record record;
  v_skipped integer := 0;
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute
        'alter default privileges for role supabase_admin revoke execute on functions from public';
      execute
        'alter default privileges for role supabase_admin revoke execute on functions from anon, authenticated, service_role';
    exception when insufficient_privilege then
      raise notice
        'Phase 4C.0: cannot alter default privileges for supabase_admin; run the documented superuser step to revoke PUBLIC/anon/authenticated/service_role function execute defaults';
    end;
  end if;

  for v_record in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) as acl
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and r.rolname = 'supabase_admin'
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  loop
    begin
      execute pg_catalog.format(
        'revoke execute on function %s from public',
        v_record.signature
      );
    exception when insufficient_privilege then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  if v_skipped > 0 then
    raise notice
      'Phase 4C.0: cannot revoke PUBLIC EXECUTE from % SECURITY DEFINER function(s) owned by supabase_admin; run the documented superuser step',
      v_skipped;
  end if;
end $$;

-- Re-state the restriction on every existing SECURITY DEFINER function owned by
-- the roles the migration can administer. This covers functions created outside
-- the Phase 4B migrations as well as the Phase 4B helpers.
do $$
declare
  v_record record;
begin
  for v_record in
    select p.oid::regprocedure as signature
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
  loop
    execute pg_catalog.format(
      'revoke execute on function %s from public',
      v_record.signature
    );
  end loop;
end $$;

-- ------------------------------------------------------------
-- Function ownership, helper grants, and role privileges
-- ------------------------------------------------------------

alter function public.onedash_dead_letter_all_jobs(text)
  owner to onedash_function_owner;
alter function public.onedash_execution_gate_change()
  owner to onedash_function_owner;
alter function public.onedash_lock_allowlist_monitor()
  owner to onedash_function_owner;
alter function public.onedash_safe_metric_bigint(text, bigint, bigint)
  owner to onedash_function_owner;

-- The function owner is NOLOGIN and no application role is a member. It needs
-- UPDATE only because SELECT ... FOR SHARE and SELECT ... FOR NO KEY UPDATE
-- require the table UPDATE privilege. PostgreSQL also applies UPDATE policies to
-- a locking SELECT, so a SELECT-only policy is not sufficient: without the
-- policies below, the locked read silently sees no rows. These policies are
-- scoped to the NOLOGIN function owner and are reachable only through the
-- SECURITY DEFINER functions above; no application role can act as this role.
grant update on table
  public.monitors,
  public.monitor_execution_settings
  to onedash_function_owner;

drop policy if exists "function owner can lock monitors" on public.monitors;
create policy "function owner can lock monitors"
  on public.monitors
  for update to onedash_function_owner
  using (true)
  with check (true);

drop policy if exists "function owner can lock execution settings"
  on public.monitor_execution_settings;
create policy "function owner can lock execution settings"
  on public.monitor_execution_settings
  for update to onedash_function_owner
  using (true)
  with check (true);

-- Trigger and metrics helpers execute as the function owner. They remain
-- revoked from PUBLIC and application roles.
revoke all on function public.onedash_dead_letter_all_jobs(text) from public;
revoke all on function public.onedash_execution_gate_change() from public;
revoke all on function public.onedash_lock_allowlist_monitor() from public;
revoke all on function public.onedash_safe_metric_bigint(text, bigint, bigint)
  from public;

-- Preserve the Phase 4B execution grants after recreating the functions.
revoke all on function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  from public;
grant execute on function public.onedash_ingest_check_result(uuid, uuid, jsonb)
  to onedash_ingestor;

revoke all on function public.onedash_queue_metrics()
  from public, onedash_worker;
grant execute on function public.onedash_queue_metrics()
  to onedash_scheduler, onedash_queue, onedash_ingestor;

revoke all on function public.onedash_dead_letter_monitor_jobs(uuid, text)
  from public;
revoke all on function public.onedash_bind_allowlist_url() from public;

comment on role onedash_function_owner is
  'Phase 4B/4C function owner. NOLOGIN. Owns only the restricted SECURITY DEFINER functions and has no application table grants outside those functions. Default PUBLIC/anon/authenticated/service_role EXECUTE is revoked for future functions. The postgres bootstrap role is a member solely to transfer function ownership; no application role is a member.';

comment on table public.check_jobs is
  'Durable Phase 4B/4C job queue. Revocation dead-letters pending and leased jobs and clears every lease/completion field. The ten-job cap is serialized per monitor with a transaction-scoped advisory lock.';
comment on table public.monitor_execution_allowlist is
  'Operator-managed fixture authorization bound to the exact monitor URL. Allowlist writes take the monitor lock first; removing a row or changing the monitor URL dead-letters pending and leased jobs.';
comment on table public.monitor_execution_settings is
  'Singleton execution gate. Disabled by default. A transition away from enabled fixtures mode dead-letters every pending and leased job.';
