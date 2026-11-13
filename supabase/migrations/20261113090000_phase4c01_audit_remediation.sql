-- ============================================================
-- Phase 4C.0.1 independent audit remediation
-- ============================================================
-- Forward-only remediation for the independent audit of Phase 4C.0. This
-- migration does NOT enable customer monitoring, does NOT wire
-- createRealChecker, and does NOT implement production network isolation.
--
-- Findings addressed here:
--   D-1  Every application-owned SECURITY DEFINER function is explicitly
--        revoked from PUBLIC, anon, authenticated, and service_role, then only
--        the intended restricted roles are regranted. The previous migration
--        revoked only PUBLIC, so a direct grant to an API role could survive.
--   A-1  onedash_claim_jobs and onedash_schedule_due_jobs now take a FOR SHARE
--        lock on the execution-gate row and validate the gate after acquiring
--        the lock. A gate disable that wins the lock prevents all new claims
--        and schedules; a claim/schedule that wins is dead-lettered when the
--        disable commits.
--   A-2  monitor_execution_allowlist.monitor_id is immutable. An update cannot
--        move authorization from monitor A to monitor B without going through
--        a delete/insert, which keeps the existing revocation triggers correct.
--   B-1  Schedule and job cap enforcement now use one transaction-scoped global
--        advisory lock. Multi-monitor inserts cannot acquire per-monitor locks
--        in opposite orders, so they cannot deadlock. The trade-off is that
--        cap-enforced inserts are serialized globally while the system remains
--        fixtures-only.
--
-- D-2 is NOT fixed by this migration. The local migration role is postgres,
-- which is not a superuser and is not a member of supabase_admin. It therefore
-- cannot alter supabase_admin's default function privileges. The operator
-- runbook in docs/runbooks/supabase-admin-function-acl.md documents the
-- privileged maintenance procedure and the required hosted verification.
--
-- Canonical lock order after this migration:
--
--     execution-gate row (FOR SHARE)
--       -> cap-enforcement advisory lock (inserts only)
--       -> job row / schedule row
--
--     monitor row (FOR SHARE / FOR NO KEY UPDATE)
--       -> execution-gate row (FOR SHARE)
--       -> allowlist read
--       -> job row
--
-- Revocation triggers keep their existing monitor-or-gate -> job order. Gate
-- transitions and monitor/allowlist revocations are standalone operator
-- transactions; they are not combined with cap-enforced inserts.
-- ============================================================

-- ------------------------------------------------------------
-- Finding B-1: globally serialized cap enforcement
-- ------------------------------------------------------------
-- The previous per-monitor advisory locks could be acquired in opposite orders
-- by two multi-row, multi-monitor transactions (A then B versus B then A). One
-- global transaction-scoped lock shared by both cap triggers guarantees a
-- single acquisition order. It is re-entrant inside a transaction, so a
-- multi-row insert still evaluates the cap after the rows already inserted by
-- that statement. Caps are unchanged: five schedules and ten pending/leased
-- jobs per monitor.

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
    -- One global cap lock for every schedule and job insert. Acquiring this
    -- before the per-monitor count makes the acquisition order identical for
    -- every transaction, including inserts that touch multiple monitors.
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
  'Enforces the five-schedule-per-monitor limit under the global cap-enforcement advisory lock and prevents ordinary users from modifying scheduler-owned columns. Region validity is enforced by the supported_regions foreign key.';

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
  -- Region validity is enforced by check_jobs_region_fk.
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
  'Caps pending plus leased jobs per monitor at ten under the same global cap-enforcement advisory lock used by schedule inserts. Region validity is enforced by check_jobs_region_fk.';

revoke execute on function public.onedash_guard_check_jobs_insert()
  from public, anon, authenticated, service_role, onedash_worker;

-- ------------------------------------------------------------
-- Finding A-2: allowlist monitor identity is immutable
-- ------------------------------------------------------------
-- The existing FOR NO KEY UPDATE monitor lock runs before allowlist writes so
-- ingestion and allowlist changes serialize. It now also rejects an UPDATE that
-- changes monitor_id. A movement from A to B can no longer bypass A's AFTER
-- DELETE revocation trigger or race an ingestion that is validating A.
-- Legitimate reason and same-monitor URL updates continue to work through the
-- existing URL-binding trigger.

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
  'Takes the monitor row lock (FOR NO KEY UPDATE) before an allowlist insert, update, or delete so allowlist changes serialize with ingestion authorization checks. Rejects any UPDATE that changes monitor_id, making monitor authorization immutable.';

revoke execute on function public.onedash_lock_allowlist_monitor()
  from public, anon, authenticated, service_role, onedash_worker;

-- ------------------------------------------------------------
-- Finding A-1: lock the execution gate before claiming or scheduling
-- ------------------------------------------------------------
-- Both functions now read the singleton gate with FOR SHARE. The gate disable
-- path is an UPDATE of the same row, so it cannot commit while a claim or
-- schedule is in progress. Once the disable commits, the AFTER trigger has
-- dead-lettered every pending and leased job. A claim or schedule that wins the
-- race completes first and is then revoked by that trigger.

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
  'Creates at most one unique job per due monitor slot. Takes a FOR SHARE lock on the execution gate and validates it after the lock. Authorization requires the allowlist URL to equal the current monitor URL.';

revoke execute on function public.onedash_schedule_due_jobs(integer, integer)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_schedule_due_jobs(integer, integer)
  to onedash_scheduler;

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

  -- Acquire the gate lock before reading the gate state. A candidate job must
  -- not be leased after a gate disable has taken effect. If this call wins the
  -- race, the gate disable waits and its AFTER trigger revokes the lease.
  select * into v_exec
  from public.monitor_execution_settings
  where singleton
  for share;

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
  'Claims pending fixture jobs using FOR UPDATE SKIP LOCKED after taking a FOR SHARE lock on and validating the execution gate. The allowlist is bound to the exact monitor URL and the host allowlist accepts only .test names.';

revoke execute on function public.onedash_claim_jobs(
  text, text, integer, integer, text[]
) from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_claim_jobs(
  text, text, integer, integer, text[]
) to onedash_queue;

-- ------------------------------------------------------------
-- Finding D-1: explicit direct-ACL hardening for application functions
-- ------------------------------------------------------------
-- Revoke from PUBLIC and every application/API role, including direct grants
-- that a prior migration or platform default may have left behind. Trigger-only
-- helpers and internal worker functions receive no API-role grant. Legitimate
-- RPC exceptions are regranted explicitly and documented below.

-- Public/authenticated RPC exceptions:
--   * waitlist_count() returns only an aggregate count; anon/authenticated may
--     execute it and the waitlist table itself remains unreadable.
--   * is_org_member/has_org_role/can_manage_org/can_write_org/is_org_owner are
--     RLS helpers that only evaluate auth.uid() membership; authenticated may
--     execute them.
--   * ensure_my_account() initializes the calling user's own account only.
--   * monitor_limit_per_org() returns the operator-managed development limit,
--     which the application needs in the authenticated server action.

revoke execute on function public.waitlist_count()
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.waitlist_count() to anon, authenticated;

revoke execute on function public.is_org_member(uuid)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.is_org_member(uuid) to authenticated;

revoke execute on function public.has_org_role(
  uuid, public.organization_role[]
) from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.has_org_role(
  uuid, public.organization_role[]
) to authenticated;

revoke execute on function public.can_manage_org(uuid)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.can_manage_org(uuid) to authenticated;

revoke execute on function public.can_write_org(uuid)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.can_write_org(uuid) to authenticated;

revoke execute on function public.is_org_owner(uuid)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.is_org_owner(uuid) to authenticated;

revoke execute on function public.ensure_user_account(uuid)
  from public, anon, authenticated, service_role, onedash_worker;

revoke execute on function public.ensure_my_account()
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.ensure_my_account() to authenticated;

revoke execute on function public.handle_new_auth_user()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.handle_auth_user_email_change()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.enforce_last_org_owner()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.validate_monitor_state_incident()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.audit_configuration_change()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.enforce_monitor_limit()
  from public, anon, authenticated, service_role, onedash_worker;

revoke execute on function public.monitor_limit_per_org()
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.monitor_limit_per_org() to authenticated;

-- Internal worker RPCs. Only the documented worker group receives EXECUTE.

revoke execute on function public.onedash_execution_status()
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_execution_status()
  to onedash_scheduler, onedash_queue, onedash_ingestor;

revoke execute on function public.onedash_extend_lease(
  uuid, uuid, integer
) from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_extend_lease(
  uuid, uuid, integer
) to onedash_queue;

revoke execute on function public.onedash_release_job(uuid, uuid)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_release_job(uuid, uuid)
  to onedash_queue;

revoke execute on function public.onedash_fail_job(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_fail_job(
  uuid, uuid, text, boolean
) to onedash_queue;

revoke execute on function public.onedash_reap_expired_leases(integer)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_reap_expired_leases(integer)
  to onedash_scheduler, onedash_queue;

revoke execute on function public.onedash_acknowledge_job(uuid, uuid)
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_acknowledge_job(uuid, uuid)
  to onedash_queue, onedash_ingestor;

revoke execute on function public.onedash_ingest_check_result(
  uuid, uuid, jsonb
) from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_ingest_check_result(
  uuid, uuid, jsonb
) to onedash_ingestor;

revoke execute on function public.onedash_record_heartbeat(
  text, text, text, jsonb
) from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_record_heartbeat(
  text, text, text, jsonb
) to onedash_scheduler, onedash_queue;

revoke execute on function public.onedash_queue_metrics()
  from public, anon, authenticated, service_role, onedash_worker;
grant execute on function public.onedash_queue_metrics()
  to onedash_scheduler, onedash_queue, onedash_ingestor;

-- Trigger-only, internal authorization, and maintenance helpers. No API or
-- worker group may invoke these directly. onedash_cleanup_stale_heartbeats is
-- deliberately scheduler-only; the queue role previously held it in Phase 4B.

revoke execute on function public.onedash_require_supported_region(text)
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_dead_letter_monitor_jobs(uuid, text)
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_dead_letter_all_jobs(text)
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_execution_gate_change()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_bind_allowlist_url()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_monitor_authorization_change()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_allowlist_revocation()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_cleanup_stale_heartbeats(integer)
  from public, anon, authenticated, service_role, onedash_worker, onedash_queue;
grant execute on function public.onedash_cleanup_stale_heartbeats(integer)
  to onedash_scheduler;

-- Non-SECURITY-DEFINER internal helpers are also not API-callable. The function
-- owner's explicit grants, where required, are intentionally preserved.
revoke execute on function public.onedash_is_fixture_hostname(text)
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_job_backoff_seconds(integer)
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_validate_result_payload(jsonb)
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_validate_heartbeat_details(text, jsonb)
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_guard_heartbeat_details()
  from public, anon, authenticated, service_role, onedash_worker;
revoke execute on function public.onedash_safe_metric_bigint(
  text, bigint, bigint
) from public, anon, authenticated, service_role, onedash_worker;

-- Repeat the default-ACL hardening for the two roles this migration can
-- administer. This is idempotent and protects future functions if a prior
-- repair re-granted the PostgreSQL default.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role onedash_function_owner
  revoke execute on functions from public, anon, authenticated, service_role;

-- D-2 remains an external production blocker. Do not fail this migration when
-- the current role cannot administer supabase_admin. The runbook records the
-- exact privileged procedure and verification.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute
        'alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon, authenticated, service_role';
    exception when insufficient_privilege then
      raise notice
        'Phase 4C.0.1: cannot alter supabase_admin default function privileges with the current migration role. D-2 remains an external production blocker; run docs/runbooks/supabase-admin-function-acl.md as supabase_admin or a superuser.';
    end;
  end if;
end $$;

-- ------------------------------------------------------------
-- Documentation comments
-- ------------------------------------------------------------

comment on table public.check_jobs is
  'Durable Phase 4B/4C job queue. Revocation dead-letters pending and leased jobs and clears every lease/completion field. The ten-job cap and the five-schedule cap share one transaction-scoped global advisory lock, so multi-monitor inserts cannot deadlock.';

comment on table public.monitor_schedules is
  'Per-monitor schedule slots. The five-schedule cap and the ten-job cap share one transaction-scoped global advisory lock, so multi-monitor inserts cannot deadlock.';

comment on table public.monitor_execution_allowlist is
  'Operator-managed fixture authorization bound to the exact monitor URL. monitor_id is immutable; moving authorization requires delete/insert so the old monitor revocation trigger fires. Allowlist writes take the monitor lock first; removing a row or changing the monitor URL dead-letters pending and leased jobs.';

comment on table public.monitor_execution_settings is
  'Singleton execution gate. Disabled by default. Claim and schedule functions hold FOR SHARE on this row while validating it. A transition away from enabled fixtures mode dead-letters every pending and leased job.';
