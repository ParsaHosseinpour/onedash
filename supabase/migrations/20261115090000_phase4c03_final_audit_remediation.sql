-- ============================================================
-- Phase 4C.0.3 independent audit remediation
-- ============================================================
-- Forward-only remediation for the final independent audit of Phase 4C.0.2.
-- This migration does NOT enable customer monitoring, does NOT wire
-- createRealChecker, does NOT deploy or modify a remote database, and does not
-- execute the privileged supabase_admin runbook.
--
-- Findings addressed here:
--   F1  onedash_dead_letter_all_jobs(text) now returns a structured JSON result
--       with updated, remaining, and cleanup_required. A zero-row batch caused by
--       locked rows never implies completion. Operators stop only when
--       cleanup_required is false.
--   F2  Every execution-gate mode transition is explicit. Leaving fixtures or
--       customer mode opens a cleanup epoch; entering an executable mode requires
--       zero pending or leased jobs. The previous enabled-customer ->
--       enabled-fixtures bypass is closed.
--   F3  Default function ACL hardening covers both the global (defaclnamespace =
--       0) and public-schema scopes for postgres and onedash_function_owner.
--       Effective permissions and legitimate grants are covered by the tests.
--   F4  Pending and leased job inserts are rejected with SQLSTATE 55000 unless
--       the gate is enabled fixtures mode. Lease extension, release, failure, and
--       reaping cannot recreate pending work after a gate revocation. Exact
--       lease-token ownership remains required.
--   F5  docs/runbooks/supabase-admin-function-acl.md is rewritten for PostgreSQL
--       17 global and per-schema default ACL behavior, routine kinds, valid
--       commands, privileged execution, evidence, and rollback. D-2 remains an
--       external hosted blocker.
--   F6  The gate activation guard uses EXISTS instead of COUNT(*), so it stops at
--       the first nonterminal row and never reports a count that can change
--       between the check and the error.
--   F7  Trigger, maintenance, dead-letter, and internal validation helpers are
--       explicitly revoked from onedash_scheduler, onedash_queue, and
--       onedash_ingestor. Scheduler-only heartbeat cleanup and the intended
--       worker RPC grants are preserved.
--   F8  Stale AFTER-trigger comments from Phase 4C.0.1 are corrected to describe
--       the current bounded cleanup path.
--
-- Lock order remains:
--
--     execution-gate row (FOR SHARE or FOR UPDATE)
--       -> cap-enforcement advisory lock (cap-enforced inserts and scheduling)
--       -> schedule row
--       -> job row
--
--     monitor row -> execution-gate row -> allowlist read -> job row (ingestion)
--     monitor row -> job row (monitor and allowlist revocation)
--
-- Direct job inserts, claims, lease operations, reaping, scheduling, and cleanup
-- all take the gate lock before any job row. This is what serializes a lease RPC
-- with a concurrent disable or cleanup.
-- ============================================================

-- ------------------------------------------------------------
-- F2/F6: explicit, fail-closed execution-gate transitions
-- ------------------------------------------------------------
-- The previous trigger missed the enabled-customer -> enabled-fixtures
-- transition and counted every nonterminal row. The policy below is exhaustive:
--
--   disabled -> fixtures   activation; zero nonterminal jobs; closes the epoch
--   disabled -> customer   activation to an unsupported mode; zero jobs; epoch
--                          remains open because customer execution is not built
--   disabled -> disabled   metadata only
--   fixtures -> fixtures   metadata only, including live queue operation
--   customer -> customer   metadata only; epoch remains open
--   fixtures -> disabled   opens a cleanup epoch; no job scan
--   customer -> disabled   opens a cleanup epoch; no job scan
--   fixtures -> customer   opens an epoch; zero nonterminal jobs required
--   customer -> fixtures   opens an epoch; zero nonterminal jobs required
--
-- Re-entering an executable mode is rejected with SQLSTATE 23514 while any
-- pending or leased job exists, regardless of the stored cleanup flag.

create or replace function public.onedash_execution_gate_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the execution gate row cannot be deleted; disable it and run bounded cleanup instead'
      using errcode = '23514',
            hint = 'Disable the gate, run public.onedash_dead_letter_all_jobs(''blocked_target'') until cleanup_required is false, and leave the singleton row in place.';
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
              hint = 'Insert the singleton row in disabled mode, run bounded cleanup until cleanup_required is false, then enable fixtures mode through an UPDATE.';
    end if;

    new.cleanup_required := true;
    new.cleanup_started_at := coalesce(new.cleanup_started_at, pg_catalog.now());
    new.cleanup_completed_at := null;
    return new;
  end if;

  -- UPDATE. Every mode transition is explicit. A same-mode update is metadata
  -- only; it cannot silently reopen or close a cleanup epoch.
  if new.mode is not distinct from old.mode then
    if new.mode = 'customer' then
      -- Customer execution is unsupported in Phase 4B/4C. Keep the fail-closed
      -- cleanup marker even when an operator updates only the reason or
      -- attestation fields.
      new.cleanup_required := true;
      new.cleanup_started_at := coalesce(old.cleanup_started_at, pg_catalog.now());
    end if;
    return new;
  end if;

  if new.mode = 'fixtures' then
    -- Activation from disabled or customer mode. The EXISTS probe is
    -- authoritative: pending and leased rows are the only executable states,
    -- and a locked row is still visible as pending or leased.
    if exists (
      select 1
      from public.check_jobs j
      where j.status in ('pending', 'leased')
    ) then
      raise exception 'execution gate cleanup is incomplete: pending or leased jobs remain'
        using errcode = '23514',
              hint = 'Keep the gate disabled and run public.onedash_dead_letter_all_jobs(''blocked_target'') until cleanup_required is false.';
    end if;

    new.cleanup_required := false;
    new.cleanup_started_at := old.cleanup_started_at;
    new.cleanup_completed_at := pg_catalog.now();
    return new;
  end if;

  if new.mode = 'customer' then
    -- Entering the unsupported customer mode requires an empty queue, but the
    -- cleanup marker stays open because customer execution is not implemented.
    if exists (
      select 1
      from public.check_jobs j
      where j.status in ('pending', 'leased')
    ) then
      raise exception 'execution gate cleanup is incomplete: pending or leased jobs remain'
        using errcode = '23514',
              hint = 'Keep the gate disabled and run public.onedash_dead_letter_all_jobs(''blocked_target'') until cleanup_required is false.';
    end if;

    new.cleanup_required := true;
    new.cleanup_started_at := coalesce(old.cleanup_started_at, pg_catalog.now());
    new.cleanup_completed_at := null;
    return new;
  end if;

  -- Target is disabled. Disable is immediate and fail-closed: open a new
  -- cleanup epoch without scanning job rows in the gate transaction.
  new.cleanup_required := true;
  new.cleanup_started_at := pg_catalog.now();
  new.cleanup_completed_at := null;
  return new;
end;
$$;

comment on function public.onedash_execution_gate_change() is
  'Fail-closed gate guard. Rejects DELETE/TRUNCATE, requires recreated rows to start disabled, defines every mode transition, opens a cleanup epoch when leaving fixtures or customer mode, and uses an EXISTS probe to block activation while any pending or leased job remains.';

-- The trigger functions are not API or worker RPCs.
revoke execute on function public.onedash_execution_gate_change()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;

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

-- ------------------------------------------------------------
-- F1: structured bounded cleanup result
-- ------------------------------------------------------------
-- The old integer return could not distinguish "no work left" from "every
-- remaining row is locked by another transaction". Return updated, remaining,
-- and cleanup_required together. A caller must stop only when cleanup_required
-- is false; an updated count of zero is not completion evidence.

drop function if exists public.onedash_dead_letter_all_jobs(text);

create function public.onedash_dead_letter_all_jobs(
  p_error_class text default 'blocked_target'
)
returns jsonb
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
  v_remaining integer := 0;
  v_cleanup_required boolean := true;
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

  -- Count remaining nonterminal work after this batch. A row skipped because
  -- another transaction holds it is still visible as pending or leased, so the
  -- epoch remains open and the result can never imply false completion.
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

    v_cleanup_required := false;
  else
    -- Keep the persisted marker aligned with the observed queue. This also
    -- repairs a stale false flag without requiring a second operator step.
    if v_gate_found then
      update public.monitor_execution_settings
      set cleanup_required = true,
          cleanup_started_at = coalesce(cleanup_started_at, v_now),
          cleanup_completed_at = null
      where singleton
        and not cleanup_required;
    end if;

    v_cleanup_required := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'updated', v_updated,
    'remaining', v_remaining,
    'cleanup_required', v_cleanup_required
  );
end;
$$;

alter function public.onedash_dead_letter_all_jobs(text)
  owner to onedash_function_owner;

comment on function public.onedash_dead_letter_all_jobs(text) is
  'Bounded gate cleanup. Locks the disabled gate row, then at most 100 pending/leased jobs in id order with FOR UPDATE SKIP LOCKED. Returns JSON {updated, remaining, cleanup_required}. A zero updated count can still leave remaining nonterminal work, so callers stop only when cleanup_required is false. Never deletes results or job history.';

revoke execute on function public.onedash_dead_letter_all_jobs(text)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;

-- ------------------------------------------------------------
-- F4: no new executable work unless fixtures mode is enabled
-- ------------------------------------------------------------
-- Direct pending or leased inserts used to be accepted while the gate was
-- disabled or missing, leaving executable rows that only the claim function
-- refused. Reject them at the table boundary. Terminal/history inserts remain
-- allowed so operators can still record completed or dead-letter history.

create or replace function public.onedash_guard_check_jobs_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_gate public.monitor_execution_settings%rowtype;
  v_gate_found boolean := false;
  v_pending integer;
begin
  -- Canonical order: execution gate, cap advisory lock, job row. Taking the
  -- gate share lock makes a direct insert serialize with gate disable, cleanup,
  -- and re-enable before any queue row becomes visible.
  select s.*
  into v_gate
  from public.monitor_execution_settings s
  where s.singleton
  for share;

  v_gate_found := found;

  if new.status in ('pending', 'leased')
     and (
       not v_gate_found
       or not v_gate.execution_enabled
       or v_gate.mode <> 'fixtures'
     ) then
    raise exception 'execution gate does not permit new queue work'
      using errcode = '55000',
            hint = 'Only enabled fixtures mode accepts pending or leased jobs. Terminal history rows are still allowed.';
  end if;

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
  'Rejects pending or leased inserts with SQLSTATE 55000 unless the execution gate exists and is enabled fixtures mode. Terminal history inserts remain allowed. Caps pending plus leased jobs per monitor at ten under the canonical gate share lock -> global cap-enforcement advisory lock -> job row order.';

revoke execute on function public.onedash_guard_check_jobs_insert()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;

-- ------------------------------------------------------------
-- F4: lease RPCs cannot recreate pending work after revocation
-- ------------------------------------------------------------
-- Each function now takes the gate share lock before touching a job row. If the
-- gate is missing, disabled, or in unsupported customer mode, a successful
-- lease-token match dead-letters the job instead of requeueing it. The exact
-- lease token is still required, so a stale or forged worker cannot terminate
-- someone else's lease.

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
  v_exec public.monitor_execution_settings%rowtype;
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

  select s.*
  into v_exec
  from public.monitor_execution_settings s
  where s.singleton
  for share;

  if not found
     or not v_exec.execution_enabled
     or v_exec.mode <> 'fixtures' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'execution_disabled',
      'execution_mode', coalesce(v_exec.mode, 'disabled')
    );
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

alter function public.onedash_extend_lease(uuid, uuid, integer)
  owner to onedash_function_owner;

comment on function public.onedash_extend_lease(uuid, uuid, integer) is
  'Extends a live lease only while the gate is enabled fixtures mode. A disabled, missing, or customer gate returns reason=execution_disabled without touching the job. An expired lease cannot be revived.';

revoke execute on function public.onedash_extend_lease(uuid, uuid, integer)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_extend_lease(uuid, uuid, integer)
  to onedash_queue;

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
  v_exec public.monitor_execution_settings%rowtype;
  v_gate_active boolean := false;
  v_status public.check_job_status;
  v_updated integer;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required' using errcode = '22023';
  end if;

  select s.*
  into v_exec
  from public.monitor_execution_settings s
  where s.singleton
  for share;

  v_gate_active :=
    found
    and v_exec.execution_enabled
    and v_exec.mode = 'fixtures';

  update public.check_jobs
  set status = case
        when not v_gate_active
          then 'dead_letter'::public.check_job_status
        when attempts >= max_attempts
          then 'dead_letter'::public.check_job_status
        else 'pending'::public.check_job_status
      end,
      available_at = case
        when not v_gate_active then available_at
        when attempts >= max_attempts then available_at
        else v_now
      end,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      completion_token = null,
      last_error_class = case
        when v_gate_active then 'worker_shutdown'
        else 'blocked_target'
      end,
      last_failure_at = v_now,
      dead_letter_at = case
        when not v_gate_active then v_now
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

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', v_status,
    'execution_mode', coalesce(v_exec.mode, 'disabled')
  );
end;
$$;

alter function public.onedash_release_job(uuid, uuid)
  owner to onedash_function_owner;

comment on function public.onedash_release_job(uuid, uuid) is
  'Releases a job only while its lease is still live and the gate is enabled fixtures mode. If the gate was disabled or changed mode, the exact lease holder dead-letters the job instead of recreating pending work. An expired lease is left to the reaper.';

revoke execute on function public.onedash_release_job(uuid, uuid)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_release_job(uuid, uuid)
  to onedash_queue;

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
  v_exec public.monitor_execution_settings%rowtype;
  v_gate_active boolean := false;
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

  select s.*
  into v_exec
  from public.monitor_execution_settings s
  where s.singleton
  for share;

  v_gate_active :=
    found
    and v_exec.execution_enabled
    and v_exec.mode = 'fixtures';

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

  if not v_gate_active
     or not v_retryable
     or v_job.attempts >= v_job.max_attempts then
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
      'max_attempts', v_job.max_attempts,
      'execution_mode', coalesce(v_exec.mode, 'disabled')
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

alter function public.onedash_fail_job(uuid, uuid, text, boolean)
  owner to onedash_function_owner;

comment on function public.onedash_fail_job(uuid, uuid, text, boolean) is
  'Requires the original live lease token. If the gate is disabled, missing, or customer mode, the job is dead-lettered even when p_retryable is true. In enabled fixtures mode it retries transient failures and dead-letters immediately when p_retryable is false or attempts are exhausted.';

revoke execute on function public.onedash_fail_job(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_fail_job(uuid, uuid, text, boolean)
  to onedash_queue;

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
  v_exec public.monitor_execution_settings%rowtype;
  v_gate_active boolean := false;
  v_row record;
  v_delay integer;
  v_recovered integer := 0;
  v_dead integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100' using errcode = '22023';
  end if;

  select s.*
  into v_exec
  from public.monitor_execution_settings s
  where s.singleton
  for share;

  v_gate_active :=
    found
    and v_exec.execution_enabled
    and v_exec.mode = 'fixtures';

  for v_row in
    select id, attempts, max_attempts
    from public.check_jobs
    where status = 'leased'
      and lease_expires_at < v_now
    order by lease_expires_at, id
    limit p_limit
    for update skip locked
  loop
    if not v_gate_active or v_row.attempts >= v_row.max_attempts then
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
    'reaped_at', v_now,
    'execution_mode', coalesce(v_exec.mode, 'disabled')
  );
end;
$$;

alter function public.onedash_reap_expired_leases(integer)
  owner to onedash_function_owner;

comment on function public.onedash_reap_expired_leases(integer) is
  'Reaps expired leases after taking the gate share lock. When the gate is disabled, missing, or customer mode, expired leases are dead-lettered instead of being returned to pending. In enabled fixtures mode, exhausted jobs are dead-lettered and the rest recover with backoff.';

revoke execute on function public.onedash_reap_expired_leases(integer)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_reap_expired_leases(integer)
  to onedash_scheduler, onedash_queue;

-- ------------------------------------------------------------
-- F7: explicit internal-role revocation for helpers
-- ------------------------------------------------------------
-- Revoke from PUBLIC and every API/worker group, including explicit grants that
-- a prior migration or platform default may have left behind. Trigger-only,
-- dead-letter, maintenance, and validation helpers have no group RPC surface.
-- Legitimate worker RPCs are untouched and retain their existing grants.

revoke execute on function public.onedash_require_supported_region(text)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_dead_letter_monitor_jobs(uuid, text)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_dead_letter_all_jobs(text)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_bind_allowlist_url()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_lock_allowlist_monitor()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_monitor_authorization_change()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_allowlist_revocation()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_guard_schedule_write()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_guard_check_jobs_insert()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;

-- Heartbeat cleanup is scheduler-only. Revoke every group first, then preserve
-- exactly that one intended grant.
revoke execute on function public.onedash_cleanup_stale_heartbeats(integer)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_cleanup_stale_heartbeats(integer)
  to onedash_scheduler;

-- Non-SECURITY-DEFINER internal helpers are also not group-callable. The
-- function owner keeps its own execute privilege for SECURITY DEFINER callers.
revoke execute on function public.onedash_is_fixture_hostname(text)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_job_backoff_seconds(integer)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_validate_result_payload(jsonb)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_validate_heartbeat_details(text, jsonb)
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_guard_heartbeat_details()
  from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;
revoke execute on function public.onedash_safe_metric_bigint(
  text, bigint, bigint
) from public, anon, authenticated, service_role, onedash_worker,
       onedash_scheduler, onedash_queue, onedash_ingestor;

-- ------------------------------------------------------------
-- F3: global and public-schema default function ACL hardening
-- ------------------------------------------------------------
-- PostgreSQL keeps global (defaclnamespace = 0) and per-schema default ACL rows
-- separately. Effective defaults for a new function are the union of both
-- scopes, so a per-schema REVOKE cannot cancel a global GRANT. Harden both
-- scopes for the two roles this migration can administer.

alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

alter default privileges for role onedash_function_owner
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role onedash_function_owner in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

-- D-2 remains an external hosted blocker. Try both scopes, but never fail the
-- local migration when postgres cannot administer supabase_admin. Existing
-- functions owned by supabase_admin still require the reviewed runbook.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute
        'alter default privileges for role supabase_admin revoke execute on functions from public, anon, authenticated, service_role';
    exception when insufficient_privilege then
      raise notice
        'Phase 4C.0.3: cannot alter the global supabase_admin default function privileges. D-2 remains an external production blocker; run docs/runbooks/supabase-admin-function-acl.md as supabase_admin or a superuser.';
    end;

    begin
      execute
        'alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon, authenticated, service_role';
    exception when insufficient_privilege then
      raise notice
        'Phase 4C.0.3: cannot alter the public-schema supabase_admin default function privileges. D-2 remains an external production blocker; run docs/runbooks/supabase-admin-function-acl.md as supabase_admin or a superuser.';
    end;
  end if;
end $$;

-- ------------------------------------------------------------
-- Documentation comments
-- ------------------------------------------------------------

comment on column public.monitor_execution_settings.cleanup_required is
  'True after a gate disable, a transition away from fixtures or customer mode, or a gate recreation until no pending or leased jobs remain. The gate cannot enter an executable mode while the flag is true and nonterminal jobs remain.';
comment on column public.monitor_execution_settings.cleanup_started_at is
  'When the current gate cleanup epoch started. Set by the gate trigger, never used to authorize work.';
comment on column public.monitor_execution_settings.cleanup_completed_at is
  'When a cleanup batch last observed zero pending and leased jobs and a fixtures-mode activation closed the epoch. Informational audit state only.';

comment on table public.check_jobs is
  'Durable Phase 4B/4C job queue. Pending and leased inserts require enabled fixtures mode. Revocation dead-letters pending and leased jobs and clears every lease/completion field. The ten-job cap and five-schedule cap share one transaction-scoped global advisory lock. The canonical order is execution gate, cap lock, schedule row, job row.';

comment on table public.monitor_schedules is
  'Per-monitor schedule slots. The five-schedule and ten-job caps share one transaction-scoped global advisory lock, acquired after the execution-gate lock and before schedule rows.';

comment on table public.monitor_execution_allowlist is
  'Operator-managed fixture authorization bound to the exact monitor URL. monitor_id is immutable and any monitor_id UPDATE raises SQLSTATE 23514 before URL binding. Allowlist writes take the monitor lock first; removing a row or changing the monitor URL dead-letters pending and leased jobs.';

comment on table public.monitor_execution_settings is
  'Singleton execution gate. Disabled by default. DELETE/TRUNCATE are rejected. Leaving fixtures or customer mode opens a cleanup epoch but does not scan jobs; bounded cleanup must run until cleanup_required is false. The gate cannot enter fixtures or customer mode while nonterminal jobs remain. A recreated row must start disabled. Customer mode is unsupported in Phase 4B/4C and keeps cleanup_required true.';
