-- ============================================================
-- Phase 4C.0.2 final review remediation
-- ============================================================
-- Forward-only remediation for the final independent review of Phase 4C.0.1.
-- This migration does NOT enable customer monitoring, does NOT wire
-- createRealChecker, and does NOT deploy or modify a remote database.
--
-- Findings addressed here:
--   E-1  Allowlist monitor_id immutability is now checked by both BEFORE
--        triggers. PostgreSQL fires same-timing triggers in name order, so the
--        URL-binding trigger used to run before the immutability trigger and a
--        monitor_id-only UPDATE could raise 22023 or 23503 instead of 23514.
--        The URL-binding trigger now rejects any monitor_id change first, so the
--        documented SQLSTATE is independent of trigger order.
--   E-2  The schedule path now acquires the global cap-enforcement advisory
--        lock before locking due schedule rows. Direct schedule and job inserts
--        take the execution-gate share lock before the cap lock. The canonical
--        order is execution gate -> cap-enforcement advisory lock -> schedule
--        row -> job row. Privileged operator transactions remain a documented
--        trust boundary; see "Trusted operator transaction rules" in
--        docs/database.md.
--   E-3  Gate disable no longer scans every pending and leased job in the gate
--        UPDATE transaction. Disable commits the fail-closed gate state
--        immediately and sets cleanup_required. Cleanup runs in bounded,
--        timeout-limited batches through onedash_dead_letter_all_jobs(), which
--        uses FOR UPDATE SKIP LOCKED. The gate cannot be re-enabled while
--        nonterminal jobs remain.
--   E-4  Direct DELETE or TRUNCATE of the singleton execution-gate row is
--        rejected. A recreated gate must start disabled and cannot silently
--        reactivate old pending or leased jobs.
--   D-1  Permission regression coverage is expanded in the pgTAP suite. This
--        migration does not change the function inventory or legitimate grants.
--   D-2  Remains an external hosted blocker. The runbook now restricts existing
--        function revocation to a reviewed explicit inventory.
--
-- Lock order after this migration:
--
--     execution-gate row (FOR SHARE or FOR UPDATE)
--       -> cap-enforcement advisory lock (cap-enforced inserts and scheduling)
--       -> schedule row
--       -> job row
--
--     monitor row -> execution-gate row -> allowlist read -> job row (ingestion)
--     monitor row -> job row (monitor and allowlist revocation)
--
-- Job-only operations (claim, extend, release, fail, reap, ingest after its
-- monitor/gate checks) lock job rows last and never acquire the cap lock
-- afterwards. Gate cleanup locks the gate row first and then job rows.
-- ============================================================

-- ------------------------------------------------------------
-- E-3/E-4: bounded gate cleanup state and fail-closed recreation
-- ------------------------------------------------------------

alter table public.monitor_execution_settings
  add column if not exists cleanup_required boolean not null default false,
  add column if not exists cleanup_started_at timestamptz,
  add column if not exists cleanup_completed_at timestamptz;

comment on column public.monitor_execution_settings.cleanup_required is
  'True after a gate disable (or a gate recreation) until no pending or leased jobs remain. The gate cannot be re-enabled while this flag is true and nonterminal jobs remain.';
comment on column public.monitor_execution_settings.cleanup_started_at is
  'When the current gate cleanup epoch started. Set by the gate trigger, never used to authorize work.';
comment on column public.monitor_execution_settings.cleanup_completed_at is
  'When a cleanup batch last observed zero pending and leased jobs. Informational audit state only.';

-- Backfill the cleanup epoch for an existing disabled gate. An enabled fixtures
-- gate does not need cleanup. An enabled customer gate is already outside the
-- Phase 4B/4C supported application paths, but it is treated as needing cleanup
-- if any nonterminal work exists.
update public.monitor_execution_settings g
set cleanup_required = case
      when g.execution_enabled and g.mode = 'fixtures' then false
      else exists (
        select 1
        from public.check_jobs j
        where j.status in ('pending', 'leased')
      )
    end,
    cleanup_started_at = case
      when not (g.execution_enabled and g.mode = 'fixtures')
        and exists (
          select 1
          from public.check_jobs j
          where j.status in ('pending', 'leased')
        )
        then pg_catalog.now()
      else null
    end,
    cleanup_completed_at = case
      when g.execution_enabled and g.mode = 'fixtures'
        or not exists (
          select 1
          from public.check_jobs j
          where j.status in ('pending', 'leased')
        )
        then pg_catalog.now()
      else null
    end
where g.singleton;

-- The old AFTER UPDATE trigger scanned and dead-lettered every job inside the
-- gate UPDATE transaction. Replace it with a BEFORE trigger that only changes
-- the gate row and validates activation. Job cleanup is a separate bounded call.
drop trigger if exists monitor_execution_settings_revoke_jobs
  on public.monitor_execution_settings;

create or replace function public.onedash_execution_gate_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_active boolean;
  v_nonterminal integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'the execution gate row cannot be deleted; disable it and run bounded cleanup instead'
      using errcode = '23514',
            hint = 'Disable the gate, run public.onedash_dead_letter_all_jobs(''blocked_target'') until it returns 0, and leave the singleton row in place.';
  end if;

  if tg_op = 'TRUNCATE' then
    raise exception 'the execution gate table cannot be truncated; disable the gate and run bounded cleanup instead'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    -- A missing gate row is fail-closed. A recreated row must also start
    -- disabled so an INSERT cannot bypass the UPDATE revocation path and make
    -- old pending or leased work executable again.
    if new.execution_enabled or new.mode <> 'disabled' then
      raise exception 'a recreated execution gate must start disabled'
        using errcode = '23514',
              hint = 'Insert the singleton row in disabled mode, run bounded cleanup, then enable fixtures mode through an UPDATE.';
    end if;

    new.cleanup_required := true;
    new.cleanup_started_at := coalesce(new.cleanup_started_at, pg_catalog.now());
    new.cleanup_completed_at := null;
    return new;
  end if;

  -- UPDATE. A transition away from enabled fixtures mode opens a cleanup epoch.
  v_was_active := old.execution_enabled and old.mode <> 'disabled';

  if old.execution_enabled
     and old.mode in ('fixtures', 'customer')
     and not (new.execution_enabled and new.mode = 'fixtures') then
    new.cleanup_required := true;
    new.cleanup_started_at := pg_catalog.now();
    new.cleanup_completed_at := null;
  end if;

  -- Reactivation from disabled, and any enabled non-fixtures mode, requires
  -- zero nonterminal jobs. A normal reason/egress update while already in
  -- enabled fixtures mode does not run this check, so operational metadata can
  -- be changed without draining the live queue.
  if new.execution_enabled
     and (new.mode <> 'fixtures' or not v_was_active) then
    select count(*)::integer
    into v_nonterminal
    from public.check_jobs j
    where j.status in ('pending', 'leased');

    if v_nonterminal > 0 then
      raise exception 'execution gate cleanup is incomplete: % pending or leased job(s) remain',
        v_nonterminal
        using errcode = '23514',
              hint = 'Keep the gate disabled and run public.onedash_dead_letter_all_jobs(''blocked_target'') in bounded batches until it returns 0.';
    end if;

    if new.cleanup_required then
      new.cleanup_required := false;
      new.cleanup_completed_at := coalesce(new.cleanup_completed_at, pg_catalog.now());
    end if;
  end if;

  return new;
end;
$$;

comment on function public.onedash_execution_gate_change() is
  'Fail-closed gate guard. Rejects DELETE/TRUNCATE, requires recreated rows to start disabled, opens a cleanup epoch on disable, and blocks reactivation while any pending or leased job remains. It does not scan jobs on disable.';

revoke execute on function public.onedash_execution_gate_change()
  from public, anon, authenticated, service_role, onedash_worker;

drop trigger if exists monitor_execution_settings_guard_write
  on public.monitor_execution_settings;
create trigger monitor_execution_settings_guard_write
  before insert or update or delete on public.monitor_execution_settings
  for each row execute function public.onedash_execution_gate_change();

drop trigger if exists monitor_execution_settings_prevent_truncate
  on public.monitor_execution_settings;
create trigger monitor_execution_settings_prevent_truncate
  before truncate on public.monitor_execution_settings
  for each statement execute function public.onedash_execution_gate_change();

-- Bounded cleanup. The previous helper locked and updated every pending and
-- leased job in one transaction. This version locks the gate row first, then at
-- most 100 job rows in id order with SKIP LOCKED. It never deletes results or
-- job history. A caller repeats the call until it returns 0. statement_timeout
-- and lock_timeout keep one batch from holding locks indefinitely.
create or replace function public.onedash_dead_letter_all_jobs(
  p_error_class text default 'blocked_target'
)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_batch constant integer := 100;
  v_gate public.monitor_execution_settings%rowtype;
  v_gate_found boolean := false;
  v_updated integer := 0;
  v_remaining integer;
begin
  if p_error_class is null
     or p_error_class not in ('blocked_target', 'worker_shutdown') then
    raise exception 'unsupported dead-letter error class' using errcode = '22023';
  end if;

  -- Gate first, then job rows. This matches the canonical lock order and
  -- serializes cleanup with a concurrent disable or re-enable attempt.
  select g.*
  into v_gate
  from public.monitor_execution_settings g
  where g.singleton
  for update;

  v_gate_found := found;

  if v_gate_found and v_gate.execution_enabled then
    raise exception 'gate cleanup is only supported while execution is disabled'
      using errcode = '55000';
  end if;

  with batch as (
    select j.id
    from public.check_jobs j
    where j.status in ('pending', 'leased')
    order by j.id
    limit v_batch
    for update skip locked
  )
  update public.check_jobs j
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
  from batch b
  where j.id = b.id;

  get diagnostics v_updated = row_count;

  -- Clear the cleanup epoch only after a fresh count sees no nonterminal work.
  -- A job skipped because another transaction holds its row remains visible as
  -- pending or leased, so the gate stays locked closed for the next batch.
  select count(*)::integer
  into v_remaining
  from public.check_jobs j
  where j.status in ('pending', 'leased');

  if v_remaining = 0 and v_gate_found then
    update public.monitor_execution_settings
    set cleanup_required = false,
        cleanup_started_at = coalesce(cleanup_started_at, v_now),
        cleanup_completed_at = v_now
    where singleton;
  end if;

  return v_updated;
end;
$$;

comment on function public.onedash_dead_letter_all_jobs(text) is
  'Bounded gate cleanup. Locks the disabled gate row, then at most 100 pending/leased jobs in id order with FOR UPDATE SKIP LOCKED. Runs with statement_timeout=5s and lock_timeout=2s, never deletes results or job history, and clears cleanup_required when no nonterminal jobs remain. Repeat until it returns 0 before re-enabling the gate.';

revoke execute on function public.onedash_dead_letter_all_jobs(text)
  from public, anon, authenticated, service_role, onedash_worker;

-- ------------------------------------------------------------
-- E-1: monitor_id immutability is independent of trigger firing order
-- ------------------------------------------------------------
-- PostgreSQL fires same-timing BEFORE ROW triggers in trigger-name order.
-- monitor_execution_allowlist_bind_url sorts before
-- monitor_execution_allowlist_lock_monitor, so the URL binding used to run
-- first. Both triggers now reject a monitor_id change, guaranteeing 23514 for
-- monitor_id-only and monitor_id-plus-URL updates.

create or replace function public.onedash_bind_allowlist_url()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  if tg_op = 'UPDATE'
     and new.monitor_id is distinct from old.monitor_id then
    raise exception 'allowlist monitor_id is immutable'
      using errcode = '23514';
  end if;

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
  'Rejects any monitor_id UPDATE with SQLSTATE 23514 before URL binding, then requires the allowlist URL to equal the current monitor URL under a monitor row lock. The immutability check is repeated in the lock trigger so trigger firing order cannot change the documented error.';

revoke execute on function public.onedash_bind_allowlist_url()
  from public, anon, authenticated, service_role, onedash_worker;

create or replace function public.onedash_lock_allowlist_monitor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_monitor_id uuid;
begin
  if tg_op = 'UPDATE'
     and new.monitor_id is distinct from old.monitor_id then
    raise exception 'allowlist monitor_id is immutable'
      using errcode = '23514';
  end if;

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
  'Takes the monitor row lock (FOR NO KEY UPDATE) before an allowlist insert, update, or delete and rejects any monitor_id UPDATE with SQLSTATE 23514. Reason and same-monitor URL updates remain allowed.';

revoke execute on function public.onedash_lock_allowlist_monitor()
  from public, anon, authenticated, service_role, onedash_worker;

-- ------------------------------------------------------------
-- E-2: one canonical cap and schedule lock order
-- ------------------------------------------------------------
-- Both direct-insert triggers take the execution-gate share lock before the
-- global cap advisory lock. onedash_schedule_due_jobs takes the same order
-- explicitly before it locks any due schedule row. Job-only operations remain
-- leaves: they lock job rows last and never acquire the cap lock afterwards.

create or replace function public.onedash_guard_schedule_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_schedule_count integer;
begin
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
    -- Canonical order: execution gate, cap advisory lock, schedule row.
    -- Ordinary users can only create a dormant schedule row because the checks
    -- above forbid scheduler-owned fields. They also have no gate-table
    -- privilege, so they take the cap lock without the gate lock; a dormant
    -- row cannot create executable work. Privileged inserts keep the full
    -- canonical order. A missing gate row is fail-closed for scheduling and is
    -- not an error for an operator fixture insert.
    if current_user not in ('authenticated', 'anon') then
      perform 1
      from public.monitor_execution_settings s
      where s.singleton
      for share;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('onedash-cap-enforcement', 0)
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
  'Enforces the five-schedule-per-monitor limit under the canonical gate -> global cap-enforcement advisory lock -> schedule row order and prevents ordinary users from modifying scheduler-owned columns.';

revoke execute on function public.onedash_guard_schedule_write()
  from public, anon, authenticated, service_role, onedash_worker;

create or replace function public.onedash_guard_check_jobs_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pending integer;
begin
  -- Canonical order: execution gate, cap advisory lock, job row. Taking the
  -- gate share lock makes a direct insert serialize with gate disable, cleanup,
  -- and re-enable even though this trigger does not authorize execution.
  perform 1
  from public.monitor_execution_settings s
  where s.singleton
  for share;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('onedash-cap-enforcement', 0)
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
  'Caps pending plus leased jobs per monitor at ten under the canonical gate share lock -> global cap-enforcement advisory lock -> job row order.';

revoke execute on function public.onedash_guard_check_jobs_insert()
  from public, anon, authenticated, service_role, onedash_worker;

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

  -- Acquire the gate lock before reading the gate state. A concurrent gate
  -- disable takes an exclusive row lock, so it either completes first (this
  -- call then sees the disabled state) or waits until this call commits.
  select * into v_exec
  from public.monitor_execution_settings
  where singleton
  for share;

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

  -- Canonical order: gate -> cap advisory lock -> schedule row -> job row.
  -- Acquiring the cap lock before the due-row scan is what prevents a
  -- transaction that holds the cap lock from deadlocking with this scheduler.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('onedash-cap-enforcement', 0)
  );

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
  'Creates at most one unique job per due monitor slot. Takes gate FOR SHARE, then the global cap-enforcement advisory lock, then due schedule rows FOR UPDATE SKIP LOCKED, then inserts jobs. Authorization requires the allowlist URL to equal the current monitor URL.';

revoke execute on function public.onedash_schedule_due_jobs(integer, integer)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_schedule_due_jobs(integer, integer)
  to onedash_scheduler;

-- ------------------------------------------------------------
-- Execution-status surface for operator cleanup loops
-- ------------------------------------------------------------

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
        'egress_verified_by', s.egress_verified_by,
        'cleanup_required', s.cleanup_required,
        'cleanup_started_at', s.cleanup_started_at,
        'cleanup_completed_at', s.cleanup_completed_at
      )
      from public.monitor_execution_settings s
      where s.singleton
    ),
    pg_catalog.jsonb_build_object(
      'enabled', false,
      'mode', 'disabled',
      'reason', 'execution settings row is missing',
      'egress_verified_at', null,
      'egress_verified_by', null,
      'cleanup_required', true,
      'cleanup_started_at', null,
      'cleanup_completed_at', null
    )
  );
$$;

comment on function public.onedash_execution_status() is
  'Returns the non-secret execution gate state, including the bounded cleanup epoch. A missing row is reported as disabled with cleanup_required=true.';

revoke execute on function public.onedash_execution_status()
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_execution_status()
  to onedash_scheduler, onedash_queue, onedash_ingestor;

-- ------------------------------------------------------------
-- Documentation comments
-- ------------------------------------------------------------

comment on table public.check_jobs is
  'Durable Phase 4B/4C job queue. Revocation dead-letters pending and leased jobs and clears every lease/completion field. The ten-job cap and five-schedule cap share one transaction-scoped global advisory lock. The canonical order is execution gate, cap lock, schedule row, job row.';

comment on table public.monitor_schedules is
  'Per-monitor schedule slots. The five-schedule and ten-job caps share one transaction-scoped global advisory lock, acquired after the execution-gate lock and before schedule rows.';

comment on table public.monitor_execution_allowlist is
  'Operator-managed fixture authorization bound to the exact monitor URL. monitor_id is immutable and any monitor_id UPDATE raises SQLSTATE 23514 before URL binding. Allowlist writes take the monitor lock first; removing a row or changing the monitor URL dead-letters pending and leased jobs.';

comment on table public.monitor_execution_settings is
  'Singleton execution gate. Disabled by default. DELETE/TRUNCATE are rejected. Disabling opens a cleanup epoch but does not scan jobs; bounded cleanup must run until no pending or leased job remains. The gate cannot be re-enabled while nonterminal jobs remain, and a recreated row must start disabled.';
