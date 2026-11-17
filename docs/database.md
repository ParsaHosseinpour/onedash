# Database foundation

This document describes the Phase 2 database model, the Phase 3 monitor
configuration and development limit, the Phase 4A.1 checker contract and result
metrics, the Phase 4B scheduler/queue/ingestion foundation, the Phase 4C.0
residual security hardening, the Phase 4C.0.1 audit remediation, the Phase
4C.0.2 final review remediation, the Phase 4C.0.3 independent audit remediation,
the migration workflow and preflight, RLS rules, split data-plane roles, and
known gaps. It reflects the code on `phase-4c/0.1-audit-remediation`; it is not a
claim that the schema has been deployed to a hosted Supabase project.

## Status

- Fifteen versioned migrations live in `supabase/migrations/`.
- `supabase db reset` applies all migrations and `supabase/seed.sql` from an
  empty local database.
- `supabase test db --local` runs 554 pgTAP assertions across thirteen files; all
  pass on a fresh reset.
- `supabase db lint --local` reports no schema errors.
- `supabase/schema.sql` is retained as the Phase 1 historical file. The
  migrations supersede it. Do not apply `schema.sql` after the migrations.
- Phase 3 adds the monitor management control plane and a database-enforced
  development monitor limit. Phase 4A adds a standalone checker foundation and
  tightens the stored monitor/result contract. Phase 4A.1 adds redirect-count
  and response-byte result columns plus a read-only migration preflight. Phase
  4B adds a scheduler, a durable PostgreSQL job table, a separate worker
  service, restricted ingestion, split database roles, and metrics. Phase 4C.0
  hardens revocation, ingestion authorization, cap concurrency, metrics,
  function default privileges, and scheduler-only cleanup without activating
  customer checks. Phase 4C.0.1 adds direct-grant ACL hardening, execution-gate
  locking, immutable allowlist monitor identity, and a global cap lock that
  removes multi-monitor deadlocks. Phase 4C.0.2 closes the final review findings:
  trigger-order-independent allowlist immutability, one canonical lock order,
  fail-closed bounded gate cleanup, and deletion/recreation protection for the
  gate row. Phase 4C.0.3 closes the independent audit findings: structured
  cleanup results, explicit fail-closed mode transitions, global and
  public-schema default-ACL hardening, direct-insert and lease-RPC revocation
  behavior, `EXISTS` activation checks, internal-helper revocation, and corrected
  trigger comments.
- Phase 4B/4C.0.3 is **not activated for customers**. The database execution gate
  is `disabled` by default, the scheduler only queues operator-allowlisted
  fixtures, and the worker refuses `customer` mode. No alert delivery or
  incident automation is added.
- No remote project has been linked or pushed. The preflight has only been run
  against the local seeded database.

The Phase 1 `schema.sql` and the waitlist migration agree on the table shape,
constraints, case-insensitive unique index, and `waitlist_count()` definition.
They intentionally differ on grants: `schema.sql` allowed anon/authenticated
INSERT, while the migration closes that direct PostgREST bypass.

## Local stack

The project id is `onedash`. Windows reserves ports `54226-54325`, so this
repository uses the `544xx` range.

| Service | URL / port |
| --- | --- |
| API / REST | `http://127.0.0.1:54421` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
| Shadow database | `54420` |
| Studio | `http://127.0.0.1:54423` |
| Mailpit | `http://127.0.0.1:54424` |
| Analytics | `54427` |
| Pooler | disabled (`54429` reserved) |

Commands:

```bash
npm run db:start
npm run db:status
npm run db:reset
npm run db:test
npm run db:lint
npm run db:stop
```

The seed creates two organizations and six confirmed local users. All seed
users use the password `onedash-dev-password1`.

| User | Organization | Role |
| --- | --- | --- |
| `owner@acme.test` | Acme Monitoring (`acme-monitoring`) | owner |
| `admin@acme.test` | Acme Monitoring | admin |
| `member@acme.test` | Acme Monitoring | member |
| `viewer@acme.test` | Acme Monitoring | viewer |
| `owner@globex.test` | Globex Status (`globex-status`) | owner |
| `admin@globex.test` | Globex Status | admin |

Acme has a published status page (`acme-status`) with one selected, active
monitor. Globex has an unpublished page. The seed also creates monitors,
schedules, check results, an open incident, a resolved incident, alert
channels, encrypted placeholder secrets, and an alert delivery.

## Migration order

1. `20261028214927_waitlist_hardening.sql` — waitlist constraints, aggregate
   count, and trusted-write grants.
2. `20261028214937_identity_and_organizations.sql` — profiles, organizations,
   memberships, RLS helpers, account bootstrap, and the `onedash_worker` group
   role.
3. `20261028214950_monitoring_foundation.sql` — monitors, schedules, state,
   check results, incidents, incident updates, request secrets, and worker
   grants.
4. `20261028215003_alerting_status_pages_audit.sql` — alert channels and
   secrets, delivery outbox, status pages, narrow public views, audit logs, and
   audit triggers.
5. `20261028220000_revoke_default_table_privileges.sql` — removes Supabase's
   default TRUNCATE/REFERENCES/TRIGGER/MAINTAIN grants from anon/authenticated
   and updates default privileges for future objects.
6. `20261028230000_monitor_limit.sql` — protected development-limit settings,
   the `monitor_limit_per_org()` read function, and the concurrency-safe
   `BEFORE INSERT` limit trigger.
7. `20261028233000_checker_contract.sql` — Phase 4A monitor restrictions
   (`GET`/`HEAD`, required TLS verification, no body assertions, redirects
   capped at five) and the extended sanitized `check_results.error_class`
   vocabulary.
8. `20261101090000_check_result_metrics.sql` — Phase 4A.1 non-negative
   `check_results.redirect_count` (not null, default 0) and nullable
   `check_results.response_bytes` counters. No body, header, URL, hostname,
   query string, or secret is added.
9. `20261102090000_scheduler_queue_ingestion.sql` - Phase 4B execution gate,
   fixture allowlist, durable `check_jobs` queue, service heartbeats, split
   `onedash_scheduler`/`onedash_queue`/`onedash_ingestor` roles, restricted
   scheduler/queue/ingestor functions, and removal of the legacy
   `onedash_worker` grants and policies.
10. `20261104090000_phase4b_security_hardening.sql` - Phase 4B function-owner
    separation, bounded region registry, URL-bound fixture authorization,
    strict heartbeat/result validation, queue completion ownership tokens, and
    removal of non-DML privileges from `service_role` on the five newer Phase 4B
    tables.
11. `20261105090000_phase4b_final_security_hardening.sql` - extends the
    `service_role` non-DML revocation (`TRUNCATE`, `REFERENCES`, `TRIGGER`, and
    PostgreSQL 17+ `MAINTAIN`) to all ten internal tables and transfers the two
    remaining reporting functions to the dedicated function owner.
12. `20261106090000_phase4c_residual_security.sql` - Phase 4C.0 forward-only
    hardening: pending/leased revocation, canonical lock ordering, full
    ingestion revalidation and structured rejection, per-monitor cap advisory
    locks, tolerant metrics, default function-execute hardening, and
    scheduler-only bounded heartbeat cleanup.
13. `20261113090000_phase4c01_audit_remediation.sql` - Phase 4C.0.1 audit
    remediation: explicit direct-ACL revocation for all application
    `SECURITY DEFINER` functions, execution-gate `FOR SHARE` locking for claim
    and schedule, immutable allowlist `monitor_id`, and one global
    cap-enforcement advisory lock shared by schedule and job inserts. It also
    reports the `supabase_admin` default-ACL limitation as an external blocker.
14. `20261113120000_phase4c02_final_remediation.sql` - Phase 4C.0.2 final
    review remediation: allowlist `monitor_id` immutability in both BEFORE
    triggers, one gate -> cap -> schedule -> job lock order, immediate
    fail-closed gate disable with bounded `SKIP LOCKED` cleanup, gate DELETE and
    TRUNCATE rejection, fail-closed gate recreation, expanded D-1 permission
    coverage, and cleanup status fields. It does not enable customer execution.
15. `20261115090000_phase4c03_final_audit_remediation.sql` - Phase 4C.0.3
    independent audit remediation: JSON cleanup results, explicit
    fail-closed gate transitions, direct pending/leased insert rejection, lease
    RPC revocation behavior, global and public-schema default-ACL hardening,
    `EXISTS` activation checks, explicit internal-helper revocation, and corrected
    trigger comments. D-2 remains an external hosted blocker. It does not enable
    customer execution.

## Entity relationship diagram

```mermaid
erDiagram
  AUTH_USERS ||--|| PROFILES : "1:1"
  AUTH_USERS ||--o{ ORGANIZATION_MEMBERS : "membership"
  ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERS : "has"
  ORGANIZATIONS ||--o{ MONITORS : "owns"
  ORGANIZATIONS ||--o{ ALERT_CHANNELS : "owns"
  ORGANIZATIONS ||--o{ STATUS_PAGES : "publishes"
  ORGANIZATIONS ||--o{ AUDIT_LOGS : "audits"

  MONITORS ||--o{ MONITOR_SCHEDULES : "scheduled in regions"
  MONITORS ||--|| MONITOR_STATE : "current state"
  MONITORS ||--o{ CHECK_RESULTS : "history"
  MONITORS ||--o{ CHECK_JOBS : "scheduled work"
  MONITORS ||--o{ MONITOR_EXECUTION_ALLOWLIST : "fixture allowlist"
  MONITORS ||--o{ INCIDENTS : "opens"
  MONITORS ||--|| MONITOR_REQUEST_SECRETS : "encrypted request"
  MONITORS ||--o{ MONITOR_ALERT_CHANNELS : "routes"
  MONITORS ||--o{ STATUS_PAGE_MONITORS : "shown on"

  INCIDENTS ||--o{ INCIDENT_UPDATES : "timeline"
  INCIDENTS ||--o{ ALERT_DELIVERIES : "notifies"

  ALERT_CHANNELS ||--|| ALERT_CHANNEL_SECRETS : "encrypted credentials"
  ALERT_CHANNELS ||--o{ MONITOR_ALERT_CHANNELS : "receives"
  ALERT_CHANNELS ||--o{ ALERT_DELIVERIES : "delivers"

  STATUS_PAGES ||--o{ STATUS_PAGE_MONITORS : "selects"
```

`auth.users` is managed by Supabase Auth. `profiles` and all tenant tables
reference it but are owned by the application schema.

`monitor_limit_settings` is an operator-only singleton table and is intentionally
not part of the tenant ERD. It stores the development limit and has no
anon/authenticated grants or policies; app roles read it only through
`monitor_limit_per_org()`. See [Monitor configuration and development
limit](#monitor-configuration-and-development-limit).

`monitor_execution_settings`, `monitor_execution_allowlist`, `check_jobs`, and
`service_heartbeats` are operator/data-plane tables. They have RLS enabled with
no policies and no direct grants to app or data-plane group roles. The
scheduler, queue, and ingestor touch them only through restricted functions.
`check_jobs` and `monitor_execution_allowlist` reference monitors; the execution
gate and heartbeat tables are deliberately independent of tenant identity.

## Tenant model

`organizations.id` is the tenant boundary. Every tenant-owned table carries
`organization_id`, and composite foreign keys ensure that a child row cannot
reference a parent from another organization. Examples:

- `monitors (id, organization_id)` is unique and is the parent key for
  schedules, state, results, incidents, request secrets, alert links, and
  status-page selections.
- `incidents (id, monitor_id, organization_id)` is unique and is the parent key
  for incident updates and alert deliveries.
- `alert_channels (id, organization_id)` is unique and is the parent key for
  channel secrets and monitor links.
- `status_pages (id, organization_id)` is unique and is the parent key for
  status-page monitor selections.

`organization_id`, `monitor_id`, `created_by`, and membership identity columns
are protected by triggers that reject changes.

## Role matrix

`authenticated` means a logged-in Supabase user. RLS is the authorization
boundary; table grants are intentionally narrower than the policies.

| Capability | owner | admin | member | viewer | anon |
| --- | --- | --- | --- | --- | --- |
| Read organization and co-members | yes | yes | yes | yes | no |
| Read own profile | yes | yes | yes | yes | no |
| Update organization | yes | yes | no | no | no |
| Delete organization | yes | no | no | no | no |
| Add/remove members (non-owner) | yes | yes | no | no | no |
| Grant/remove owner | yes | no | no | no | no |
| Read monitors, schedules, state, results, incidents, updates | yes | yes | yes | yes | no |
| Create/update/delete monitors and schedules | yes | yes | yes | no | no |
| Create/delete incidents | yes | yes | no | no | no |
| Update incidents | yes | yes | yes | no | no |
| Add incident updates as self | yes | yes | yes | no | no |
| Read alert-channel metadata | yes | yes | yes | yes | no |
| Create/update/delete alert channels and links | yes | yes | no | no | no |
| Read alert deliveries | yes | yes | no | no | no |
| Read/write alert deliveries | no | no | no | no | no |
| Read status pages and selected monitors | yes | yes | yes | yes | no |
| Create/update/delete status pages and selections | yes | yes | no | no | no |
| Read audit logs | yes | yes | no | no | no |
| Read encrypted request/alert secrets | no | no | no | no | no |
| Insert waitlist rows | service role only | service role only | service role only | service role only | no |
| Read public published status pages | anon + authenticated | anon + authenticated | anon + authenticated | anon + authenticated | yes |
| Read effective monitor limit (`monitor_limit_per_org`) | yes | yes | yes | yes | no |
| Change monitor limit settings | operator SQL only | operator SQL only | operator SQL only | operator SQL only | operator SQL only |

Phase 4B removes the broad `onedash_worker` role from the data plane. The role
is retained as a deprecated NOLOGIN role, but every table, sequence, function,
schema, and policy grant is revoked. Data-plane access is split by function:

| Capability | onedash_scheduler | onedash_queue | onedash_ingestor | checker module |
| --- | --- | --- | --- | --- |
| Schedule due jobs | yes | no | no | no |
| Claim, extend, release, or fail jobs | no | yes | no | no |
| Acknowledge a job | no | yes | yes | no |
| Ingest a validated result and complete its job atomically | no | no | yes | no |
| Reap expired leases | yes | yes | no | no |
| Record scheduler/worker heartbeat | yes | yes | no | no |
| Read aggregate queue metrics | yes | yes | yes | no |
| Read/write application tables directly | no | no | no | no |
| Hold a database credential | yes | yes | yes | no |
| Receive customer URLs or request secrets | no | no | no | minimal in-memory config only |

All four capabilities are exercised through restricted `SECURITY DEFINER`
functions with `search_path = ''`. `PUBLIC`, `anon`, `authenticated`, and
`service_role` have no unintended execute privilege on those functions, and the
three group roles have no direct table privileges. The
checker module receives only the claimed job's minimal configuration (URL,
method, expected statuses, timeout, TLS/redirect flags, and a
`has_request_secrets` marker); it has no database client and no service-role
key.

## RLS helpers

All helpers are `SECURITY DEFINER`, use `set search_path = ''`, fully qualify
object names, explicitly revoke execute from PUBLIC and application roles, and
grant execute only to the role that needs them. They read
`organization_members` as the function owner, which avoids recursive RLS
evaluation.

| Helper | Meaning |
| --- | --- |
| `is_org_member(org_id)` | The current `auth.uid()` has any membership in the organization. |
| `has_org_role(org_id, roles[])` | The current user has one of the listed roles. |
| `can_manage_org(org_id)` | Current role is `owner` or `admin`. |
| `can_write_org(org_id)` | Current role is `owner`, `admin`, or `member`. |
| `is_org_owner(org_id)` | Current role is `owner`. |
| `ensure_my_account()` | Authenticated wrapper around the idempotent bootstrap. |
| `ensure_user_account(user_id)` | Internal bootstrap helper; not executable by app roles. |

`auth.uid()` comes from the Supabase JWT. Tests set
`request.jwt.claims` to simulate users and then `set local role authenticated`.

### Safe views

- `organization_directory` is a security-definer view with an explicit
  `is_org_member` filter. It exposes co-member display names, avatars, roles,
  and join dates, but not profile emails.
- `public_status_pages` exposes only published `slug`, `name`, `description`,
  `branding`, and `updated_at`.
- `public_status_page_monitors` exposes only `status_page_slug`,
  `monitor_name`, `monitor_status`, and `last_checked_at` for published pages
  whose selected monitor is active.

The public views are security-definer views owned by the migration role. Do not
add internal IDs, organization IDs, URLs, emails, or secret fields to their
select lists.

## Secrets

Secrets are separated from non-secret configuration:

- `alert_channels.config` is non-secret routing metadata. Authenticated users
  receive column-level SELECT on metadata but not on `config`; the check
  constraint rejects keys such as `token`, `secret`, `password`,
  `authorization`, `api_key`, and `webhook_url`.
- `alert_channel_secrets` stores ciphertext and an encryption-key id. It has RLS
  and a worker-only SELECT policy/grant. Anon/authenticated have no privileges.
- `monitor_request_secrets` stores encrypted request headers/bodies. It has RLS
  and a worker-only SELECT policy/grant. Anon/authenticated have no privileges.
- `audit_logs.metadata` rejects obvious secret keys and is capped at 8 KiB.
- The service-role key is server-only. In this phase it is used only by the
  waitlist insert path, and `service_role` has only INSERT on `waitlist` (no
  SELECT). It is not a general application database role.

Never log, commit, or expose the service-role key. Do not put it in a
`NEXT_PUBLIC_` variable. `src/lib/waitlist-service.ts` imports
`src/lib/server-guard.ts`, and `getSupabaseServiceRoleEnv()` is only called
from server code.

## Waitlist hardening

The migration:

- Normalizes existing emails to `lower(btrim(email))` after pre-flight checks
  for duplicates, invalid addresses, and unsupported sources.
- Enforces length 3–254, lowercase normalization, a basic email shape, and the
  `landing_page` source.
- Creates a unique index on `lower(email)` and drops the old case-sensitive
  unique constraint.
- Enables RLS and creates no anon/authenticated policies.
- Revokes all table privileges from anon/authenticated. The direct PostgREST
  INSERT bypass is closed.
- Grants `service_role` INSERT only. The Next.js route validates, normalizes,
  rate-limits, and then inserts with the service-role key.
- Keeps `waitlist_count()` as a `SECURITY DEFINER` aggregate with an empty
  `search_path`, executable by anon/authenticated, so the UI can show a count
  without reading emails.

The in-process waitlist rate limiter is still per instance. A shared limiter or
WAF is required before a multi-instance public launch.

## Account bootstrap

- An `auth.users` INSERT trigger calls `ensure_user_account(new.id)`.
- An email-change trigger refreshes the profile email and re-runs the
  idempotent bootstrap.
- `ensure_user_account` takes a transaction-scoped advisory lock, upserts the
  profile, and creates a personal organization plus owner membership only when
  the user has no membership. Re-running it returns the existing organization.
- Existing auth users are backfilled during the migration.
- The seed inserts confirmed users, which fires the trigger, then renames the
  two owner organizations and adds the remaining memberships.

## Monitor configuration and development limit

Phase 3 adds no tenant tables. It reuses the Phase 2 `monitors` and
`monitor_state` tables and adds one operator-only settings table plus one
trigger.

### Application access

- Monitor Server Actions use the cookie-scoped Supabase client and RLS. They do
  not use the service-role key.
- `requireUser()` supplies the authenticated user id. The server resolves the
  user's oldest membership to determine the organization and role; no
  organization id, role, user id, ownership flag, or limit is accepted from the
  browser.
- Owners, admins, and members can write. Viewers are read-only. RLS and the
  Phase 2 policies remain the final authorization boundary.
- Create/update input is validated on the server: name length, absolute
  HTTP/HTTPS URL, no embedded credentials, ports 80/443, `GET`/`HEAD`, expected
  status codes (single/list/range, max 20), interval 60–86,400 seconds, and
  timeout 1–60 seconds shorter than the interval. Obvious localhost/private
  targets are rejected at configuration time; the standalone Phase 4A checker
  adds DNS/redirect SSRF enforcement, but it is not wired to the application
  yet.
- Deletion requires the exact monitor name. The server re-reads the name from
  the database before deleting.
- Repository selects name explicit safe columns:
  `id,name,url,method,expected_status_codes,interval_seconds,timeout_seconds,is_active,created_at,updated_at`.
  Scheduler fields, encrypted request secrets, ciphertext, and worker
  credentials are not returned to the browser. `last_checked_at` comes only
  from `monitor_state`; it is never derived from `updated_at`.
- The list query is capped at 200 rows. The dashboard shows the true count and
  a notice when the list is truncated. There is no pagination yet.

### Phase 4A checker contract

The Phase 4A checker lives outside the Next.js app in `worker/checker/`. It
reuses the Phase 2/3 schema rather than creating a parallel model. The
`20261028233000_checker_contract.sql` migration tightens the stored contract to
match what the checker can actually execute:

| Field / constraint | Phase 4A rule |
| --- | --- |
| `method` | `GET` or `HEAD` only. |
| `verify_tls` | Must be `true`; TLS verification is never disabled. |
| `expected_body_text` | Must be `null`; body assertions are not implemented. |
| `expected_body_is_regex` | Must be `false`; regex assertions are not implemented. |
| `follow_redirects` / `max_redirects` | When following, the budget is 1–5; otherwise it must be 0. |
| `expected_status_codes` | Non-empty, at most 20, each 100–599 (existing rule). |
| `timeout_seconds` | 1–60 and shorter than the interval (existing rule). |

The checker independently revalidates these fields and returns
`unsupported_configuration` for a row that violates them. This is intentional:
a migration cannot protect a worker that reads a stale or directly-inserted
row, and the checker must not silently ignore a configured field.

The checker never writes results in Phase 4A/4A.1. The `check_results.error_class`
constraint now includes the sanitized Phase 4A classes
`connection_failure`, `redirect_failure`, `response_too_large`, and
`unsupported_configuration`, alongside the existing classes. No response body,
header, URL, query string, or secret is stored in a result.

Phase 4A.1 adds two result counters through
`20261101090000_check_result_metrics.sql`:

| Column | Rule | Purpose |
| --- | --- | --- |
| `redirect_count` | `integer not null default 0`, `>= 0` | Number of redirect hops the checker followed. |
| `response_bytes` | `integer`, `null` or `>= 0` | Body bytes read and discarded; `null` when no body was read. |

The checker already returns both values in its sanitized result. Phase 4B
persists them through `onedash_ingest_check_result`, which derives tenant and
monitor identity from the job row and stores the counters. The migration is
additive and does not modify the published Phase 4A migration.
`007_check_result_metrics.sql` covers stored values, defaults, negative-value
rejection, and cross-tenant read isolation.

### Migration preflight

The Phase 4A monitor migration (`20261028233000_checker_contract.sql`) can fail
on legacy Phase 2/3 rows that do not meet the stricter monitor constraints.
Before applying it to an existing database, run the read-only check:

```bash
psql "$DATABASE_URL" -f supabase/preflight/phase_4a_monitor_compatibility.sql
```

It opens a `READ ONLY` transaction with a 30-second statement timeout, reports
each blocking monitor and reason, summarizes the count, checks
`check_results.error_class` against the Phase 4A vocabulary, and rolls back. It
does not delete, disable, rewrite, or migrate any row.

An operator must confirm `blocking_monitors = 0` before applying the migration.
Review every reported row (method, TLS verification, body assertions, redirect
budget) and decide remediation with the monitor owner. This round did not run
the preflight against a remote database and did not auto-fix any monitor. Use a
database copy or read-only role; do not run it against production without
explicit approval, and take a backup before any production migration.

### Limit settings

`public.monitor_limit_settings` is a singleton table:

| Column | Meaning |
| --- | --- |
| `singleton` | Boolean primary key, constrained to `true`. |
| `limit_per_org` | Integer, `1`–`10,000`, default `25`. |
| `updated_at` | Maintained by the existing `set_updated_at()` trigger. |

RLS is enabled with **no** policies, and all privileges are revoked from
`PUBLIC`, `anon`, and `authenticated`. App roles cannot read or change the
table directly.

`public.monitor_limit_per_org()` is `STABLE SECURITY DEFINER` with
`search_path = ''`. It returns the configured value, or `25` if no row exists.
Execute is revoked from `PUBLIC` and granted only to `authenticated`; `anon`
cannot call it.

`public.enforce_monitor_limit()` is a `SECURITY DEFINER` `BEFORE INSERT`
trigger function with `search_path = ''`. For each inserted row it:

1. Takes a transaction-scoped advisory lock keyed by
   `onedash-monitor-limit:<organization_id>`.
2. Counts all monitors for `new.organization_id` as the function owner
   (bypassing RLS).
3. Raises SQLSTATE `P0001` with `Monitor limit reached for this organization
   (N).` when the count is at or above the limit.

The lock is held until the transaction ends. Concurrent inserts for one
organization serialize, so two requests cannot both observe the last slot. The
lock is also taken by direct privileged inserts, not only Server Actions.

The app performs a friendly pre-check using the RLS-scoped count and
`monitor_limit_per_org()`, but that check is **not** authoritative. The trigger
is the enforcement point. The repository maps `P0001` to a safe limit message.

The limit counts active and paused monitors and applies to every insert,
including seed data and operator SQL. Change it as a database operator:

```sql
update public.monitor_limit_settings set limit_per_org = 50;
```

This is a development guard, not a plan or billing entitlement. There is no
Stripe integration. A value above 200 means the dashboard list is truncated
until pagination is added.

## Phase 4B data plane and roles

Phase 4B adds the scheduler, durable queue, worker service, and restricted
ingestion, but **does not activate customer monitoring**. The execution gate is
disabled by default. The worker and scheduler are separate Node processes from
Next.js, and the checker remains a standalone module with no database client.

### Queue choice

The queue is a PostgreSQL job table (`public.check_jobs`) with transactional
claiming. Supabase Queues (PGMQ) 1.5.1 was available in the local Postgres 17
image but was not installed. PGMQ provides durable messages and a visibility
timeout, but it does not provide the Phase 4B requirements for idempotency-key
deduplication, maximum attempts, exponential backoff, terminal dead-letter
state, and simple restricted-role auditing in one place. A dedicated table with
unique constraints and restricted functions is simpler to operate and test.

`check_jobs` has:

- A unique `idempotency_key` and a unique
  `(monitor_id, region, scheduled_for)` slot. A duplicate scheduler tick cannot
  create a second logical job.
- `scheduled_for` (the logical UTC slot) and `available_at`
  (`scheduled_for` plus deterministic jitter). Workers cannot claim before
  `available_at`.
- A per-claim `lease_token`, `lease_owner`, `lease_expires_at`, `attempts`, and
  `max_attempts`. Claiming increments attempts. Extend, release, fail, and
  ingest all require the matching unexpired lease token.
- Statuses `pending`, `leased`, `completed`, and `dead_letter`, with constraints
  preventing lease fields on non-leased rows and terminal timestamps on the
  wrong states.
- Exponential backoff in `onedash_fail_job`, capped at 300 seconds, and a
  terminal `dead_letter` row when the attempt budget is exhausted.
- A reaper (`onedash_reap_expired_leases`) that returns expired jobs to
  `pending` or dead-letters them when the attempt budget is exhausted. It
  increments `lease_expired_count` and records `lease_expired` as the sanitized
  error class. When the gate is disabled, missing, or in customer mode, expired
  leases are dead-lettered instead of requeued.

### Execution gate and fixture allowlist

`public.monitor_execution_settings` is a singleton operator table:

- Default: `mode = 'disabled'`, `execution_enabled = false`.
- The check constraint keeps `execution_enabled = (mode <> 'disabled')`.
- `customer` mode additionally requires `egress_verified_at` and
  `egress_verified_by`, but Phase 4B still refuses to schedule or claim
  customer work.
- There are no anon/authenticated or data-plane grants and no RLS policies.
  Only an operator with direct database access can change it.
- A disable transition commits the fail-closed state immediately and opens a
  cleanup epoch (`cleanup_required = true`). It does **not** scan or update job
  rows in the gate transaction. `cleanup_started_at` and `cleanup_completed_at`
  are informational audit fields exposed by `onedash_execution_status()`.
- Every mode transition is explicit. Leaving fixtures or customer mode opens an
  epoch. Entering fixtures or customer mode requires zero pending or leased jobs.
  Customer mode is unsupported, so it keeps `cleanup_required = true` even when
  its activation succeeds; the enabled-customer -> enabled-fixtures path
  therefore cannot bypass cleanup. Same-mode metadata updates never silently open
  or close an epoch.
- Operators run `public.onedash_dead_letter_all_jobs('blocked_target')` until the
  JSON result reports `cleanup_required = false`. The result contains `updated`,
  `remaining`, and `cleanup_required`. A zero `updated` count only means the
  remaining rows are locked or unavailable; it is never completion evidence.
  Keep the gate disabled and retry after releasing the blockers.
- Pending and leased inserts are rejected with SQLSTATE `55000` unless the gate
  exists and is enabled fixtures mode. Terminal history inserts remain allowed.
  Lease extension is refused while the gate is inactive; release, failure, and
  reaping dead-letter a valid lease instead of recreating pending work.
- `DELETE` and `TRUNCATE` on the gate table are rejected with SQLSTATE `23514`.
  A missing row is reported as disabled with `cleanup_required = true`. A
  recreated row must start disabled; an INSERT cannot silently reactivate old
  work.
- Ordinary `authenticated`/`anon` schedule inserts cannot set scheduler-owned
  fields, so they take the cap lock without the gate lock. Privileged schedule
  inserts and all job inserts take the canonical gate -> cap -> row order.
  Scheduler-owned inserts are operator-managed and fail closed if the gate row
  is missing.

`public.monitor_execution_allowlist` is an operator-managed list of monitor IDs
that may be scheduled in fixtures mode. It is not a customer activation
mechanism. The scheduler joins through it, and the claim function requires both
that row and the worker's `ONEDASH_FIXTURE_HOSTS` host allowlist. A fixture
worker therefore cannot claim a non-fixture host even if the database gate is
misconfigured.

### Scheduler

`worker/scheduler/` runs a long-lived loop. Each tick:

1. Reads the execution gate and logs mode changes.
2. At most once per hour, deletes heartbeat rows older than 24 hours through
   `onedash_cleanup_stale_heartbeats(86400)`. The retention is far longer than
   an active scheduler/worker heartbeat interval, so live rows are never
   selected. A cleanup failure is logged and does not skip the rest of the tick.
3. Reaps a bounded batch of expired leases.
4. Calls `onedash_schedule_due_jobs(batch_size, jitter_seconds)`.
5. Records a sanitized scheduler heartbeat.

The scheduling function takes the execution-gate share lock, then the global
cap-enforcement advisory lock, and only then locks due schedule rows with
`FOR UPDATE OF s SKIP LOCKED`. That order is what prevents a cap-lock holder
from deadlocking with the scheduler when the holder also updates a due schedule
row. Multiple scheduler instances remain safe. It only considers active
monitors with a non-null `next_run_at <= now()` and a fixture allowlist row. It
creates at most one job per logical slot and advances
`monitor_schedules.next_run_at` in the same transaction. If the scheduler was
down across multiple intervals, it creates one catch-up job and moves the next
run to `now() + interval` instead of creating a backlog. All timestamps are
`timestamptz`; the idempotency key uses the UTC slot. Jitter is deterministic
per slot, not random per tick, so retries and multiple schedulers agree.

### Worker and queue behavior

`worker/service/` is a separate Node service with bounded concurrency. In
`disabled` mode it heartbeats but never claims. In `fixtures` mode it:

- Requires `ONEDASH_FIXTURE_HOSTS` and an allowlisted monitor.
- Claims up to the free concurrency slots with `FOR UPDATE SKIP LOCKED`.
- Extends leases while a check is in flight and aborts the check if the lease
  is lost.
- Uses the Phase 4A checker unchanged through `worker/checker/adapter.ts`.
- Ingests checker output only. Fixture mode uses a deterministic, network-free
  fixture checker for `.test` hosts, so stored results are synthetic test data,
  not customer uptime. It never makes arbitrary external customer requests.
- Releases work on graceful shutdown, fails with exponential backoff, and
  dead-letters after `max_attempts`.
- Records worker heartbeats and exposes health/metrics. Customer URLs,
  hostnames, headers, bodies, secrets, and organization IDs are not logged.

The service listens on `/healthz`, `/readyz`, and `/metrics` (default
`127.0.0.1:9464`). `/readyz` checks both the queue and ingestor connections.
`/metrics` includes runtime counters and aggregate queue metrics. A bearer
token is required when the health host is not loopback.

### Ingestion

`worker/ingestor/` calls `onedash_ingest_check_result(job_id, lease_token,
payload)`. The function:

- Validates a strict payload vocabulary and rejects unknown fields.
- Locks the job row and derives organization, monitor, region, scheduled slot,
  and idempotency key from the job, not the payload. A caller cannot redirect a
  result to another monitor or tenant.
- Inserts into `check_results` with `ON CONFLICT (monitor_id,
  idempotency_key) DO NOTHING`, so a retry after a committed transaction returns
  the existing result instead of duplicating it.
- Updates `monitor_state` atomically only when the new result is at least as new
  as the stored `last_checked_at`.
- Completes the matching job in the same transaction. A lost lease rolls back
  the ingestion.
- Creates no incidents, incident updates, alert deliveries, or notifications.
  Phase 5 owns that state machine.

### Permissions and credentials

The migration creates three NOLOGIN group roles:
`onedash_scheduler`, `onedash_queue`, and `onedash_ingestor`. Deployment must
create separate LOGIN roles and grant exactly one group role to each process.
The scheduler, queue, and ingestor group roles have **no direct table
privileges**; they only execute the restricted functions listed in the role
matrix. The legacy `onedash_worker` role has no direct table, sequence, function,
schema, or policy grants. `PUBLIC` retains `USAGE` on schema `public`, so the
role can see schema object names, but it has no data access.

Only administrative privileges are revoked; the migration does not alter any
DML grant. In the current schema `service_role` has no direct table privilege on
the ten internal tables (`check_jobs`, `service_heartbeats`,
`monitor_execution_settings`, `monitor_execution_allowlist`,
`supported_regions`, `check_results`, `monitor_state`, `monitor_schedules`,
`monitors`, and `monitor_request_secrets`): user-facing monitor/result access is
through `authenticated` RLS policies, and scheduler/queue/ingestor access is
through the restricted functions. `service_role` specifically has no
`TRUNCATE`, `REFERENCES`, `TRIGGER`, or PostgreSQL 17+ `MAINTAIN` privilege on
any of the ten tables, so it cannot bypass RLS with a full-table truncate,
create constraints/triggers, or run physical maintenance. The 35 application
`SECURITY DEFINER` functions are owned by the NOLOGIN NOINHERIT
`onedash_function_owner` role or the migration `postgres` role, have an empty
`search_path`, and explicitly revoke `EXECUTE` from PUBLIC, `anon`,
`authenticated`, and `service_role`. Only the documented public RPC exceptions
and worker group functions are regranted.

The checker module has no database client, no service-role key, and no direct
private-data access. The worker process holds the restricted queue and ingestor
connections and passes the checker only the claimed job's minimal configuration
in memory. Do not grant the checker `monitor_request_secrets`,
`alert_channel_secrets`, or incident/state mutation.

### Phase 4C.0 residual hardening

Phase 4C.0 is forward-only and keeps the same security model and
default-disabled gate. It does not enable customer checks, wire a real checker
into the worker, or add incident/alert behavior.

**Canonical lock order.** Authorization-sensitive work takes locks in this
order: execution-gate row (`FOR SHARE`), the global cap-enforcement advisory
lock (cap-enforced inserts and scheduling), schedule rows, then job rows.
Ingestion takes the monitor row (`FOR SHARE`), the execution-gate row, reads the
allowlist under the monitor lock, then locks the job last. Allowlist writes and
monitor revocation take the monitor row (`FOR NO KEY UPDATE`) and revoke job
rows second. Claim and other job-only operations lock job rows last and never
acquire the cap lock afterwards. Gate cleanup locks the gate row first and jobs
second in `id` order. This one order replaces the Phase 4C.0.1 schedule-before-
cap path, which could deadlock with a cap-lock holder that also updated a due
schedule row. The 4C.0.2 migration and integration test pin the order.

**Revocation clears all ownership.** Pausing a monitor, changing its URL, or
removing its allowlist row dead-letters both `pending` and `leased` jobs in the
revocation transaction. Disabling the execution gate no longer scans jobs: it
commits the fail-closed gate state immediately, and operator-invoked bounded
cleanup performs the revocation. Every revocation clears `lease_owner`,
`lease_token`, `lease_expires_at`, `completion_token`, and `completed_at`, and
sets `dead_letter_at` and a sanitized error class. A stale worker cannot complete
a revoked job.

**Ingestion revalidation.** `onedash_ingest_check_result` pre-reads the job
identity, share-locks the monitor, share-locks the execution gate, reads the
allowlist under the monitor lock, then locks the job last and revalidates the
token, expiry, and status. It returns structured JSON with a fixed reason and
`retryable = false` for: `job_not_found`, `monitor_not_found`,
`execution_disabled`, `monitor_not_authorized`, `lease_mismatch`,
`lease_mismatch_or_expired`, and `job_completed_without_result`. Rejections
write no `check_results` row and do not update `monitor_state`.

**Cap serialization.** The five-schedule and ten-pending-plus-leased-job caps
share one transaction-scoped `onedash-cap-enforcement` advisory lock. The
schedule and job insert triggers acquire the execution-gate share lock first
(except for an ordinary `authenticated`/`anon` dormant schedule insert, which
has no gate-table privilege), then the cap lock, then count rows. The scheduler
takes the same gate and cap locks before it locks due schedule rows. Two
multi-monitor transactions therefore cannot acquire schedule or job locks in
opposite orders and deadlock. The lock is re-entrant inside a transaction, so a
multi-row insert is still evaluated per row against rows already inserted by
that statement. Cap-enforced inserts are serialized globally while the system
remains fixtures-only; this is an accepted throughput trade-off, not a
customer-scale claim.

**Metrics tolerance.** `onedash_queue_metrics()` uses
`onedash_safe_metric_bigint` for legacy heartbeat values. It accepts only 1-18
ASCII digits, clamps per-heartbeat concurrency to 0-10, and clamps counts,
ages, durations, and totals to `2147483647`. A malformed legacy row is ignored
instead of failing the aggregate.

**Default function privileges.** Phase 4C.0.1 explicitly revokes `EXECUTE` from
PUBLIC, `anon`, `authenticated`, and `service_role` on every application
`SECURITY DEFINER` function, not only PUBLIC. It then regrants only the
documented public RPC exceptions and worker group functions; trigger helpers and
internal authorization helpers receive no API or worker grant. Phase 4C.0.3
harden both the global (`defaclnamespace = 0`) and `public`-schema default
function ACLs for `postgres` and `onedash_function_owner`, because PostgreSQL
unions both scopes and a per-schema `REVOKE` cannot cancel a global `GRANT`.
Internal trigger, dead-letter, maintenance, and validation helpers are
explicitly revoked from the scheduler, queue, and ingestor groups, while
scheduler-only heartbeat cleanup and the intended worker RPC grants are
preserved. The local `postgres` role is not a member of `supabase_admin`, so it
cannot alter that superuser's default ACLs in either scope or revoke grants on
functions owned by it. The migration reports this as an external production
blocker. An operator must run `docs/runbooks/supabase-admin-function-acl.md` as
`supabase_admin` or a superuser, inspect both scopes, and verify on the hosted
project. Do not assume the limitation is fixed by the local migration alone.

**Bounded cleanup.** `onedash_cleanup_stale_heartbeats(integer)` is executable
only by `onedash_scheduler`; `onedash_queue`, `anon`, `authenticated`, and
PUBLIC are denied. It validates retention (60-31,536,000 seconds), runs with
function-level `statement_timeout = 5s` and `lock_timeout = 2s`, deletes at most
1,000 rows per statement and 10,000 per call using `FOR UPDATE SKIP LOCKED`, and
selects only rows strictly older than the cutoff. Active heartbeats are never
deleted. Cleanup failure remains non-fatal to the scheduler tick.

**Worker database timeouts.** Worker queue, ingestor, scheduler, and health
connections use `statement_timeout = 15s`, `lock_timeout = 5s`, and
`idle_in_transaction_session_timeout = 10s` by default. These are client-side
pool defaults, separate from the tighter cleanup function settings.

### Phase 4C.0.1 audit remediation

Phase 4C.0.1 is a forward-only migration over Phase 4C.0. It does not enable
customer checks, wire a real checker, or change the default-disabled gate.

- **D-1 direct grants.** Every application `SECURITY DEFINER` function is
  explicitly revoked from PUBLIC, `anon`, `authenticated`, and `service_role`.
  The pgTAP matrix covers all 35 functions, their direct ACL entries, the worker
  group matrix, and function ownership. Public RPC exceptions remain
  `waitlist_count()` for anon/authenticated, the organization RLS helpers and
  `ensure_my_account()` for authenticated, and `monitor_limit_per_org()` for
  authenticated.
- **A-1 execution-gate race.** `onedash_claim_jobs` and
  `onedash_schedule_due_jobs` read the singleton settings row with `FOR SHARE`
  before validating it. A gate disable that wins the row lock is observed by the
  waiting call; a call that wins and commits before the disable is revoked by
  bounded cleanup rather than by the disable transaction itself.
- **A-2 allowlist identity.** An update that changes
  `monitor_execution_allowlist.monitor_id` raises SQLSTATE `23514`. Moving
  authorization requires delete/insert, which keeps the old monitor's revocation
  trigger in the path. Reason and same-monitor URL updates still work. Phase
  4C.0.2 repeats this check in both BEFORE triggers so trigger firing order
  cannot change the error.
- **B-1 cap deadlock.** The global cap lock described above replaces the
  per-monitor namespaces. Opposite-order multi-monitor job and schedule inserts
  serialize instead of deadlocking; the caps remain five schedules and ten
  pending-plus-leased jobs per monitor.
- **D-2 hosted default ACL.** Not fixed locally. See
  `docs/runbooks/supabase-admin-function-acl.md` and record hosted verification
  before claiming closure. This is an external production blocker.

### Phase 4C.0.2 final review remediation

Phase 4C.0.2 is a forward-only migration over Phase 4C.0.1. It does not enable
customer checks, wire `createRealChecker`, change the 35-function inventory, or
alter the default-disabled gate.

- **E-1 trigger-order-independent immutability.** Both
  `onedash_bind_allowlist_url()` and `onedash_lock_allowlist_monitor()` reject
  any `monitor_id` change with SQLSTATE `23514` before doing other work.
  PostgreSQL fires same-timing BEFORE triggers in name order, and the URL-binding
  trigger sorts first, so the check now exists in both functions. A
  `monitor_id`-only update and a combined `monitor_id`-plus-URL update return the
  same documented error.
- **E-2 canonical lock order.** The only supported order is execution gate ->
  cap-enforcement advisory lock -> schedule row -> job row. The scheduler takes
  the gate and cap locks before its due-row scan. Direct schedule and job inserts
  take the gate share lock before the cap lock. Ordinary `authenticated`/`anon`
  schedule inserts are the narrow exception: the trigger forbids them from
  setting scheduler-owned fields and they have no gate-table privilege, so they
  take the cap lock without the gate lock. A dormant row cannot create
  executable work, and this preserves the security-invoker path and the 35
  function grants.
- **E-3 fail-closed bounded cleanup.** Gate disable commits the disabled state
  immediately and opens a cleanup epoch; it does not scan jobs. Operators run
  `onedash_dead_letter_all_jobs('blocked_target')` in fixed 100-row batches until
  the structured result reports `cleanup_required = false`. The function locks the
  gate first, uses `FOR UPDATE SKIP LOCKED`, runs with
  `statement_timeout = 5s` and `lock_timeout = 2s`, and never deletes result or
  job history. `cleanup_required` stays true and gate re-enable is rejected with
  SQLSTATE `23514` while any pending or leased job remains. A locked row that is
  skipped keeps the gate closed for the next batch. Phase 4C.0.3 replaced the
  plain integer result with `{updated, remaining, cleanup_required}` so a
  zero-row batch cannot be mistaken for completion.
- **E-4 gate deletion and recreation.** A row-level DELETE and a statement-level
  TRUNCATE both raise SQLSTATE `23514`. A missing gate row is reported by
  `onedash_execution_status()` as disabled with `cleanup_required = true`, and
  scheduling and claiming fail closed. A recreated INSERT must start disabled;
  the trigger forces `cleanup_required = true` and a new cleanup epoch, so old
  pending or leased work cannot become executable.
- **D-1 permission coverage.** The pgTAP suite now checks all 35 application
  `SECURITY DEFINER` functions per role, unexpected grantees, the public-schema
  `postgres` default function ACL, and preservation of the legitimate public RPC
  and worker grants. These tests detect privilege regressions; they do not change
  the intended grant matrix.
- **D-2 hosted default ACL.** Still not fixed locally and still an external
  hosted-project blocker. The runbook now uses an explicit reviewed function
  inventory rather than revoking every function in the schema. Do not mark D-2
  fixed from a local database.

### Phase 4C.0.3 independent audit remediation

Phase 4C.0.3 is a forward-only migration over Phase 4C.0.2. It does not enable
customer checks, wire `createRealChecker`, deploy a hosted database, or execute
the privileged `supabase_admin` runbook. It closes the eight findings from the
independent audit of commit `4c71a3a`:

- **F1 structured cleanup.** `onedash_dead_letter_all_jobs(text)` returns
  `jsonb` with `updated`, `remaining`, and `cleanup_required`. The function
  re-owns under `onedash_function_owner`, revokes every API and worker group, and
  keeps the gate-first `FOR UPDATE SKIP LOCKED` batch behavior. A zero-row batch
  with remaining nonterminal work keeps the epoch open and is never completion
  evidence.
- **F2 explicit transitions.** The gate trigger defines every mode transition.
  Disabled -> fixtures requires an empty queue and closes the epoch only after
  zero pending/leased jobs. Disabled -> customer requires an empty queue but
  keeps the marker open because customer execution is unsupported.
  Fixtures/customer -> disabled opens an epoch without scanning rows. Versioned
  transitions in either direction require zero nonterminal jobs; customer ->
  fixtures cannot bypass cleanup. Same-mode metadata never silently changes the
  epoch. The gate INSERT path still forces a disabled, cleanup-required row.
- **F3 default ACL scopes.** The migration hardens both global
  (`defaclnamespace = 0`) and `public`-schema default function ACLs for
  `postgres` and `onedash_function_owner`. PostgreSQL 17 unions both scopes; a
  per-schema `REVOKE` cannot cancel a global `GRANT`. The migration attempts both
  scopes for `supabase_admin` and catches `insufficient_privilege`, so D-2
  remains an external hosted blocker rather than a false local claim. pgTAP
  checks catalog ACLs, effective permissions on newly created functions, and
  PUBLIC/anon/authenticated/service_role denials while preserving legitimate
  grants.
- **F4 direct-insert and lease revocation.** Pending or leased inserts raise
  SQLSTATE `55000` unless the gate exists and is enabled fixtures mode. The
  insert trigger takes the gate `FOR SHARE` before the cap lock and job row.
  `onedash_extend_lease` returns `execution_disabled` without touching the job
  when the gate is inactive. Release and failure dead-letter a valid live lease
  instead of recreating pending work, and the reaper dead-letters expired leases
  while the gate is inactive. Exact lease-token ownership remains required, and
  terminal/history inserts remain allowed.
- **F5 runbook.** `docs/runbooks/supabase-admin-function-acl.md` now covers both
  default-ACL scopes, PostgreSQL 17/Supabase behavior, `pg_proc.prokind` values
  `f`/`p`/`a`/`w`, valid `ON ROUTINE`/`ON PROCEDURE` commands, a reviewed
  privileged procedure, evidence capture, and rollback. D-2 remains unresolved.
- **F6 EXISTS activation guard.** The activation guard uses an `EXISTS` probe
  instead of `COUNT(*)`, so it stops at the first nonterminal row and raises the
  authoritative message
  `execution gate cleanup is incomplete: pending or leased jobs remain`.
- **F7 internal helper revocation.** Trigger, dead-letter, maintenance, and
  validation helpers are explicitly revoked from `onedash_scheduler`,
  `onedash_queue`, and `onedash_ingestor`. Scheduler-only heartbeat cleanup and
  the intended worker RPC grants remain unchanged.
- **F8 stale comments.** The Phase 4C.0.1 migration comments now describe the
  current bounded cleanup path instead of a transaction-time AFTER trigger.

**Trusted operator transaction rules.** `postgres`, migration owners, and
members of the operator roles can write tables directly, so they are a trusted
boundary rather than a security boundary. Their transactions must:

1. Take the execution-gate row lock before any cap-enforced schedule or job
   insert, and before locking schedule rows. Ordinary application inserts and the
   scheduler do this automatically; a hand-written multi-statement transaction
   must not reorder the locks.
2. Take the cap-enforcement advisory lock
   (`pg_advisory_xact_lock(hashtextextended('onedash-cap-enforcement', 0))`)
   before inserting schedules or jobs, and before updating a due schedule row in
   a transaction that also inserts a job.
3. Never update or delete `check_results` history to clean up work. Disable the
   gate and use the bounded cleanup function.
4. Never delete or truncate the execution-gate row. Leave the singleton row in
   place and use the disable/cleanup/enable sequence.

### Activation prerequisites

Phase 4B/4C.0.3 must not be used to monitor customer URLs. Before customer
activation in a later phase:

1. Implement and review the production egress-isolated worker host. The
   application checker's DNS/IP policy is not a substitute for network policy.
2. Verify egress denial for private, loopback, link-local, metadata,
   control-plane, and Supabase private networks; record the verification in
   `monitor_execution_settings.egress_verified_at/by`.
3. Add the customer scheduling/claim path, which Phase 4B deliberately does not
   implement, and remove the fixture-only host filters.
4. Add multi-region routing, confirmation/quorum policy, load tests, and an
   operational runbook.
5. Obtain explicit approval before changing the execution gate. Do not set
   `customer` mode in this phase.

## Check-result retention and partitioning plan

`check_results` is append-only and deliberately has no response-body or
response-header columns. It does store the non-sensitive `redirect_count` and
`response_bytes` counters added by Phase 4A.1. Current indexes:

- `(monitor_id, checked_at desc)` for per-monitor history.
- `(organization_id, checked_at desc)` for tenant history.
- `(checked_at)` for time-based maintenance.
- Unique `(monitor_id, idempotency_key)` for at-least-once ingestion.

The table is **not partitioned yet**, and no rollup tables exist. The proposed
Phase 2/Phase 4 plan is:

1. Create a range-partitioned parent on `checked_at`, with monthly partitions
   (for example `check_results_2026_10`).
2. Keep the same indexes on each partition and add a default partition for
   late writes.
3. Run a scheduled retention job that detaches/drops partitions older than the
   agreed raw window. The roadmap proposes 30–90 days; the final value is an
   open product decision.
4. Add 1-minute, 1-hour, and 1-day rollup tables (or materialized views) for
   charts and long-term history. Rollups are not implemented in Phase 2.
5. Run `VACUUM`/`ANALYZE` and partition-maintenance jobs from a scheduled
   worker, not from the Next.js web tier.

Until partitioning lands, monitor table size and retention manually.

## Testing

The pgTAP suite is in `supabase/tests/database/`:

- `001_schema_invariants.sql` — RLS coverage, indexes, constraints, function
  hardening, default privilege removal, and waitlist privileges.
- `002_tenant_isolation.sql` — anon denial, same-org access, other-org denial,
  owner/admin/member/viewer permissions, last-owner invariant, bootstrap
  idempotency, and legacy-worker denial.
- `003_constraints_and_waitlist.sql` — monitor/schedule/result/incident
  constraints, idempotency, waitlist validation, and service-role write path.
- `004_public_status_pages.sql` — published-only public views, active/selected
  monitor filtering, and unpublish/deactivate behavior.
- `005_monitor_management.sql` — monitor RLS and role enforcement, cross-tenant
  denial, creator/org forgery, the protected development limit, privileged
  bypass attempts, and the per-organization advisory lock.
- `006_checker_contract.sql` — Phase 4A monitor restrictions (`GET`/`HEAD`,
  required TLS verification, no body assertions, redirect cap) and the extended
  `check_results.error_class` vocabulary.
- `007_check_result_metrics.sql` — Phase 4A.1 `redirect_count` and
  `response_bytes` storage, defaults, non-negative constraints, and tenant
  isolation.
- `008_phase4b_queue_permissions.sql` - Phase 4B role separation, split function
  grants, legacy-worker denial, execution-gate defaults, queue constraints, RLS
  with no policies, and restricted-role execution smoke checks.
- `009_phase4b_security_hardening.sql` - Phase 4B.2 function ownership,
  `PUBLIC` execute denial, empty `search_path`, URL-bound fixture
  authorization, strict heartbeat/result validation, and `service_role` non-DML
  denial across all ten internal tables.
- `010_phase4c_residual_security.sql` - Phase 4C.0 pending/leased revocation,
  canonical lock ordering, ingestion revalidation and structured rejection,
  concurrency-safe per-monitor caps, tolerant metrics, default function-execute
  hardening, and scheduler-only bounded cleanup.
- `011_phase4c01_audit_remediation.sql` - Phase 4C.0.1 complete 35-function
  `SECURITY DEFINER` ACL matrix, direct-grant detection, worker grants,
  function-owner/default-ACL checks, allowlist `monitor_id` immutability, and
  the explicit D-2 external-blocker diagnostic. Phase 4C.0.2 extends it with
  per-role effective checks for all 35 functions, unexpected-grantee detection,
  public-schema `postgres` default-ACL checks, and preservation of the
  legitimate public RPC and worker grants.
- `012_phase4c02_final_remediation.sql` - Phase 4C.0.2 more-than-one-batch
  cleanup (110 pending jobs across two batches plus a skipped locked row),
  immediate fail-closed disable, ingestion rejection during cleanup,
  re-enable blocking, result and job-history preservation, gate DELETE/TRUNCATE
  rejection, missing-row behavior, and fail-closed recreation.
- `013_phase4c03_final_audit_remediation.sql` - Phase 4C.0.3 structured cleanup
  results and zero-row semantics, explicit gate transitions, direct pending and
  leased insert rejection with SQLSTATE `55000`, missing-gate behavior, lease
  revocation behavior, `EXISTS` activation checks, global and public-schema
  default-ACL scopes, effective API-role denials, preserved legitimate grants,
  internal-helper revocation, and scheduler-only heartbeat cleanup.

The suite currently has **554 assertions across thirteen files**.

Phase 4B/4C.0.3 also has separate multi-connection integration tests:
`tests/phase4b/database-pipeline.test.ts`,
`tests/phase4b/residual-security.test.ts`, and
`tests/phase4b/audit-remediation-concurrency.test.ts`. They are not part of the
default `npm test` suite because they need a running local database. The
pipeline test creates four independent connections using disposable
`onedash_test_*` login roles, then verifies scheduler idempotency and
concurrent-scheduler safety, claim/lease ownership, retries and dead-lettering,
expired-lease recovery, restricted ingestion and monitor-state updates, the
execution gate, fixture host allowlisting, metrics, and permission denial. The
residual test adds independent connection races for the schedule and job caps,
the shared global cap lock, multi-row inserts, concurrent identical ingestion,
lease expiry while blocked on the job row, and ingestion rejection/no-write
behavior. The audit-remediation test adds opposite-order multi-monitor job and
schedule inserts, mixed schedule-plus-job transactions, gate-disable races
against claims and scheduling, a canonical cap-before-schedule lock-order test,
a 110-job `SKIP LOCKED` cleanup that must finish in more than one bounded batch,
and Phase 4C.0.3 coverage for all-locked independent connections and concurrent
cleanup/gate transitions in both lock directions. All use dedicated monitors and
clean up their roles and rows. Run them with:

```bash
npm run test:phase4b
```

Run:

```bash
npm run db:reset
npm run db:test
npm run db:lint
```

The tests run against the seeded local database. They create their own users
and organizations inside a transaction and roll back. Assertions are scoped to
test-specific slugs and IDs so seed data does not make counts ambiguous.

## Known gaps and deviations

1. **Customer execution is not implemented.** The execution gate is disabled,
   the scheduler only queues operator-allowlisted fixtures, and the worker
   refuses `customer` mode. There is no outbound customer request, test-check
   action, alert sender, or customer-facing uptime data. Do not describe
   customer checks as running.
2. **Ingestion does not create incidents or notifications.** It stores the
   submitted checker result, updates `monitor_state`, and completes the job.
   Fixture-mode results are synthetic `.test` data, not customer uptime.
   Confirmation policy, incidents, and alert delivery remain Phase 5 work.
3. **Egress isolation is not implemented by this repository.** The checker
   rejects non-public addresses and pins validated DNS answers, but application
   validation alone is not sufficient. The worker host/network must deny
   egress to private, link-local, loopback, metadata, control-plane, and
   Supabase private networks. If the hosting environment cannot enforce that,
   customer checks are a release blocker. See `worker/README.md`.
4. **No multi-region routing or load test.** Phase 4B runs one fixture region
   (`local-1` by default). Region routing, confirmation/quorum, capacity, and
   load targets remain unverified.
5. **No partitioning or rollups.** Retention and partitioning are documented
   but not implemented. `check_results` is a normal table.
6. **No shared waitlist limiter.** The direct anon INSERT bypass is closed, but
   the remaining rate limit is in-process and per instance.
7. **Auth E2E is manual only.** The signup, email confirmation, callback,
   dashboard, refresh, logout, and login flow passed in a browser against this
   local stack on 2026-10-28. No Playwright suite runs in CI, so the README
   checklist remains required after auth changes.
8. **No hosted deployment.** Migrations have not been pushed to a remote
   Supabase project. Do not run `supabase db push` against production without
   review and a backup.
9. **Phase 4B/4C.0.3 integration coverage is local-only.** The pipeline test
   uses four restricted-role connections, requires a running local Supabase
   database, and creates disposable login roles. The residual test adds
   independent-connection cap races, global cap-lock checks, concurrent
   ingestion, and rejection/no-write assertions. The audit-remediation test adds
   opposite-order multi-monitor inserts, gate-disable races, a canonical
   cap-before-schedule lock assertion, multi-batch bounded cleanup, all-locked
   zero-row cleanup, and concurrent cleanup/gate transitions. Together
   they include a worker-runtime end-to-end pass through the restricted queue
   and ingestor clients. They are not hosted, multi-region, or
   failure-injection tests.
10. **The monitor limit is a development guard.** It is not a plan or billing
    entitlement. The default is 25 per organization and is operator-editable.
11. **The monitor list is capped at 200 rows.** There is no pagination; the
    dashboard shows a truncation notice when the organization count is larger.
12. **Service-role scope is minimal.** It can INSERT waitlist rows and has the
    default non-DML grants, but it cannot SELECT waitlist rows. Future server
    features need explicit, reviewed grants.
13. **The Phase 4A preflight is local-only so far.** It was run against the
    seeded local database (3 monitors, 0 blocking, 0 unexpected error classes).
    It has not been run against a remote or production database, and no remote
    database has been linked, modified, or reset.
14. **The legacy worker role is retained.** `onedash_worker` is a deprecated
    NOLOGIN role with no direct table, sequence, function, schema, or policy
    grants. `PUBLIC` still exposes schema `USAGE`, but the role has no data
    access.
    It exists only so old deployment configuration fails closed while it is
    migrated to the split roles.
15. **The `supabase_admin` default-ACL hardening is not applied locally
    (D-2).** The migration role `postgres` is not a member of the local
    superuser `supabase_admin`, so it cannot alter that role's global or
    `public`-schema default function privileges or revoke grants on functions it
    owns. The migration attempts both scopes, emits a notice for each scope it
    cannot change, and the pgTAP suite records the limitation as an external
    production blocker. A privileged operator must complete
    `docs/runbooks/supabase-admin-function-acl.md` and record hosted
    verification before relying on default-ACL hardening for functions created
    by that role.