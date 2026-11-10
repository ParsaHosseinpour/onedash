-- ============================================================
-- Phase 4B.2 final security hardening
-- ============================================================
-- Forward-only completion of the Phase 4B security hardening. This migration
-- does NOT enable customer monitoring. The execution gate remains disabled by
-- default and customer mode is still refused by both components.
--
-- Only administrative privileges are revoked; this migration does not alter any
-- DML grant. service_role loses TRUNCATE, REFERENCES, TRIGGER, and (PostgreSQL
-- 17+) MAINTAIN on every table used by the Phase 4B functions:
--
--   * TRUNCATE is not filtered by RLS and would let a PostgREST-adjacent role
--     erase an entire internal table.
--   * REFERENCES is only needed to create foreign keys against a table.
--   * TRIGGER is only needed to create triggers on a table.
--   * MAINTAIN covers VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH MATERIALIZED VIEW
--     and other physical maintenance.
--
-- No application feature creates constraints or triggers, truncates a table, or
-- runs physical maintenance as service_role. The scheduler, queue, and ingestor
-- continue to use their restricted SECURITY DEFINER RPC functions.
--
-- The two SECURITY DEFINER reporting functions created by the earlier Phase 4B
-- queue migration were left owned by postgres. Transfer them to the dedicated
-- NOLOGIN NOINHERIT function owner so every Phase 4B SECURITY DEFINER function
-- has the same owner. Their intended execution grants are re-stated after the
-- ownership change and PUBLIC execute is explicitly removed.
-- ============================================================

-- ------------------------------------------------------------
-- service_role non-DML privilege removal on all ten tables
-- ------------------------------------------------------------

revoke truncate, references, trigger on table
  public.check_jobs,
  public.service_heartbeats,
  public.monitor_execution_settings,
  public.monitor_execution_allowlist,
  public.supported_regions,
  public.check_results,
  public.monitor_state,
  public.monitor_schedules,
  public.monitors,
  public.monitor_request_secrets
  from service_role;

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on table '
      || 'public.check_jobs, '
      || 'public.service_heartbeats, '
      || 'public.monitor_execution_settings, '
      || 'public.monitor_execution_allowlist, '
      || 'public.supported_regions, '
      || 'public.check_results, '
      || 'public.monitor_state, '
      || 'public.monitor_schedules, '
      || 'public.monitors, '
      || 'public.monitor_request_secrets '
      || 'from service_role';
  end if;
end $$;

-- Keep the table-level default privileges aligned for future tables created by
-- the migration role. The earlier hardening migration already did this for the
-- first five Phase 4B tables; repeating the statement is idempotent and makes
-- the final state explicit in the forward-only migration.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from service_role;

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute
      'alter default privileges for role postgres in schema public revoke maintain on tables from service_role';
  end if;
end $$;

-- ------------------------------------------------------------
-- Complete Phase 4B SECURITY DEFINER ownership
-- ------------------------------------------------------------

alter function public.onedash_execution_status()
  owner to onedash_function_owner;
alter function public.onedash_queue_metrics()
  owner to onedash_function_owner;

-- Ownership changes do not add PUBLIC execute, but re-state the restriction so
-- a partially applied or manually repaired database cannot leave these
-- reporting functions callable by PUBLIC or an application role.
revoke all on function public.onedash_execution_status()
  from public, anon, authenticated, service_role, onedash_worker;
revoke all on function public.onedash_queue_metrics()
  from public, anon, authenticated, service_role, onedash_worker;

-- Preserve the intended execution grants from the Phase 4B role matrix.
grant execute on function public.onedash_execution_status()
  to onedash_scheduler, onedash_queue, onedash_ingestor;
grant execute on function public.onedash_queue_metrics()
  to onedash_scheduler, onedash_queue, onedash_ingestor;

comment on function public.onedash_execution_status() is
  'Returns the non-secret execution gate state. Owned by onedash_function_owner; PUBLIC execute is revoked and execution is limited to the scheduler, queue, and ingestor groups.';
comment on function public.onedash_queue_metrics() is
  'Aggregate queue, scheduler, worker, timeout, and check-duration metrics. Owned by onedash_function_owner; PUBLIC execute is revoked and execution is limited to the scheduler, queue, and ingestor groups.';
