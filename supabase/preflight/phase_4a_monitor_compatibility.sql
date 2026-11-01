-- ============================================================
-- Phase 4A.1 read-only migration preflight
-- ============================================================
-- Run this BEFORE applying 20261028233000_checker_contract.sql to a database
-- that already contains Phase 2/3 monitor rows. It only reads data. It does not
-- delete, disable, rewrite, or migrate any monitor.
--
-- Recommended use: a read-only role or a database copy. Do not run it against a
-- remote production database from this repository. This round did not connect
-- to, modify, or reset any remote database.
--
--   psql "$DATABASE_URL" -f supabase/preflight/phase_4a_monitor_compatibility.sql
--
-- A non-empty result in the first query means the stricter migration would
-- fail its CHECK constraints until an operator reviews those rows. The second
-- query is a summary. The third query checks the result error vocabulary.
-- ============================================================

begin transaction read only;

set local statement_timeout = '30s';

-- 1. Monitor rows that would block the Phase 4A monitor constraints.
with monitor_violations as (
  select
    m.id,
    m.organization_id,
    m.name,
    array_remove(
      array[
        case
          when m.method not in ('GET', 'HEAD')
            then 'method=' || m.method::text
        end,
        case
          when not m.verify_tls then 'verify_tls=false'
        end,
        case
          when m.expected_body_text is not null
            then 'expected_body_text is not null'
        end,
        case
          when m.expected_body_is_regex
            then 'expected_body_is_regex=true'
        end,
        case
          when m.follow_redirects and (m.max_redirects < 1 or m.max_redirects > 5)
            then 'max_redirects=' || m.max_redirects::text
        end,
        case
          when not m.follow_redirects and m.max_redirects <> 0
            then 'max_redirects_without_follow_redirects=' || m.max_redirects::text
        end
      ],
      null
    ) as violations
  from public.monitors m
)
select
  id,
  organization_id,
  name,
  violations
from monitor_violations
where cardinality(violations) > 0
order by organization_id, id;

-- 2. Summary. blocking_monitors should be 0 before the migration is applied.
with monitor_violations as (
  select
    array_remove(
      array[
        case when m.method not in ('GET', 'HEAD') then 'method' end,
        case when not m.verify_tls then 'verify_tls' end,
        case when m.expected_body_text is not null then 'expected_body_text' end,
        case when m.expected_body_is_regex then 'expected_body_is_regex' end,
        case
          when m.follow_redirects and (m.max_redirects < 1 or m.max_redirects > 5)
            then 'max_redirects'
        end,
        case
          when not m.follow_redirects and m.max_redirects <> 0
            then 'max_redirects_without_follow_redirects'
        end
      ],
      null
    ) as violations
  from public.monitors m
)
select
  count(*)::bigint as total_monitors,
  count(*) filter (where cardinality(violations) > 0)::bigint as blocking_monitors,
  coalesce(sum(cardinality(violations)), 0)::bigint as blocking_conditions
from monitor_violations;

-- 3. Result rows whose error_class is outside the Phase 4A vocabulary. The new
-- constraint is a superset of the Phase 2 vocabulary, so this should normally
-- be empty; a non-empty result means the old constraint was bypassed or
-- disabled and must be reviewed before the migration.
select
  r.id,
  r.organization_id,
  r.monitor_id,
  r.error_class
from public.check_results r
where r.error_class is not null
  and r.error_class not in (
    'dns_failure',
    'connection_refused',
    'connection_failure',
    'timeout',
    'tls_error',
    'http_status_mismatch',
    'body_mismatch',
    'redirect_loop',
    'redirect_failure',
    'blocked_target',
    'response_too_large',
    'unsupported_configuration',
    'internal_error',
    'latency_threshold'
  )
order by r.organization_id, r.id;

rollback;
