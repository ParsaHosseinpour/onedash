# Database foundation

This document describes the Phase 2 database model, the Phase 3 monitor
configuration and development limit, the migration workflow, RLS rules, worker
role, and known gaps. It reflects the code on
`phase-3/monitor-management`; it is not a claim that the schema has been
deployed to a hosted Supabase project.

## Status

- Six versioned migrations live in `supabase/migrations/`.
- `supabase db reset` applies all migrations and `supabase/seed.sql` from an
  empty local database.
- `supabase test db --local` runs 188 pgTAP assertions; all pass on a fresh
  reset.
- `supabase db lint --local` reports no schema errors.
- `supabase/schema.sql` is retained as the Phase 1 historical file. The
  migrations supersede it. Do not apply `schema.sql` after the migrations.
- Phase 3 adds the monitor management control plane and a database-enforced
  development monitor limit. It does not add a scheduler or checker, and no
  outbound customer request is made.
- No remote project has been linked or pushed. Phase 4 has not started.

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

| Capability | owner | admin | member | viewer | worker |
| --- | --- | --- | --- | --- | --- |
| Read organization and co-members | yes | yes | yes | yes | no |
| Read own profile | yes | yes | yes | yes | no |
| Update organization | yes | yes | no | no | no |
| Delete organization | yes | no | no | no | no |
| Add/remove members (non-owner) | yes | yes | no | no | no |
| Grant/remove owner | yes | no | no | no | no |
| Read monitors, schedules, state, results, incidents, updates | yes | yes | yes | yes | yes |
| Create/update/delete monitors and schedules | yes | yes | yes | no | no |
| Create/delete incidents | yes | yes | no | no | yes |
| Update incidents | yes | yes | yes | no | yes |
| Add incident updates as self | yes | yes | yes | no | yes |
| Read alert-channel metadata | yes | yes | yes | yes | yes |
| Create/update/delete alert channels and links | yes | yes | no | no | no |
| Read alert deliveries | yes | yes | no | no | yes |
| Read/write alert deliveries | no | no | no | no | yes |
| Read status pages and selected monitors | yes | yes | yes | yes | no |
| Create/update/delete status pages and selections | yes | yes | no | no | no |
| Read audit logs | yes | yes | no | no | no |
| Read encrypted request/alert secrets | no | no | no | no | yes |
| Insert waitlist rows | service role only | service role only | service role only | service role only | no |
| Read public published status pages | anon + authenticated | anon + authenticated | anon + authenticated | anon + authenticated | no |
| Read effective monitor limit (`monitor_limit_per_org`) | yes | yes | yes | yes | no |
| Change monitor limit settings | operator SQL only | operator SQL only | operator SQL only | operator SQL only | operator SQL only |

The worker role is a global scheduler role. It can read monitoring and
alerting rows for all tenants, but it has no access to profiles,
organizations, memberships, audit logs, status pages, or waitlist rows. See
[Worker role](#worker-role) for the exact grants and the known deviation from
the roadmap wording.

## RLS helpers

All helpers are `SECURITY DEFINER`, use `set search_path = ''`, fully qualify
object names, revoke execute from `PUBLIC`, and grant execute only to the role
that needs them. They read `organization_members` as the function owner, which
avoids recursive RLS evaluation.

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
  targets are rejected at configuration time; full DNS/redirect SSRF
  enforcement is Phase 4.
- Deletion requires the exact monitor name. The server re-reads the name from
  the database before deleting.
- Repository selects name explicit safe columns:
  `id,name,url,method,expected_status_codes,interval_seconds,timeout_seconds,is_active,created_at,updated_at`.
  Scheduler fields, encrypted request secrets, ciphertext, and worker
  credentials are not returned to the browser. `last_checked_at` comes only
  from `monitor_state`; it is never derived from `updated_at`.
- The list query is capped at 200 rows. The dashboard shows the true count and
  a notice when the list is truncated. There is no pagination yet.

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

## Worker role

`onedash_worker` is a `NOLOGIN` group role. Production should create a separate
login role, grant it `onedash_worker`, and use that connection for the
scheduler/checker. Do not use the service-role key as the worker's database
identity.

Worker grants:

- SELECT: `monitors`, `monitor_schedules`, `monitor_state`, `check_results`,
  `incidents`, `incident_updates`, `alert_channels`, `alert_channel_secrets`,
  `monitor_alert_channels`, `alert_deliveries`, `monitor_request_secrets`.
- INSERT: `check_results`, `incidents`, `incident_updates`, `monitor_state`,
  `alert_deliveries`.
- UPDATE: `monitor_schedules`, `monitor_state`, `incidents`, `alert_deliveries`.
- No access to `profiles`, `organizations`, `organization_members`,
  `audit_logs`, `status_pages`, `status_page_monitors`, or `waitlist`.

The worker RLS policies use `using (true)` / `with check (true)` because a
global scheduler must process every tenant. This is intentional, but it means
the roadmap sentence "worker ... cannot ... read unrelated tenants" is not met
as written. The worker can read monitoring and alerting rows across tenants; it
cannot manage users or read unrelated tenant identity, audit, or status-page
data. Treat the worker connection as a high-privilege data-plane credential.

## Check-result retention and partitioning plan

`check_results` is append-only and deliberately has no response-body or
response-header columns. Current indexes:

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
  idempotency, and worker grants.
- `003_constraints_and_waitlist.sql` — monitor/schedule/result/incident
  constraints, idempotency, waitlist validation, and service-role write path.
- `004_public_status_pages.sql` — published-only public views, active/selected
  monitor filtering, and unpublish/deactivate behavior.
- `005_monitor_management.sql` — monitor RLS and role enforcement, cross-tenant
  denial, creator/org forgery, the protected development limit, privileged
  bypass attempts, and the per-organization advisory lock.

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

1. **Worker cross-tenant access.** Intentional for a global scheduler, but it
   does not satisfy the roadmap's literal "cannot read unrelated tenants"
   wording. The worker is limited to monitoring/alerting tables.
2. **No partitioning or rollups.** Retention and partitioning are documented
   but not implemented. `check_results` is a normal table.
3. **No shared waitlist limiter.** The direct anon INSERT bypass is closed, but
   the remaining rate limit is in-process and per instance.
4. **Auth E2E is manual only.** The signup → email confirmation → callback →
   dashboard → refresh → logout → login flow passed in a browser against this
   local stack on 2026-10-28. No Playwright suite runs in CI, so the README
   checklist remains required after auth changes.
5. **No hosted deployment.** Migrations have not been pushed to a remote
   Supabase project. Do not run `supabase db push` against production without
   review and a backup.
6. **No scheduler or checker.** Phase 3 defines and manages the configuration
   contract only. There is no test-check action, outbound request, result
   ingestion, or alert delivery; the checker/scheduler is Phase 4.
7. **Full SSRF protection is not implemented.** Configuration-time validation
   rejects obvious private targets, but it does not resolve DNS, pin addresses,
   or revalidate redirects. Do not enable customer checks before Phase 4.
8. **The monitor limit is a development guard.** It is not a plan or billing
   entitlement. The default is 25 per organization and is operator-editable.
9. **The monitor list is capped at 200 rows.** There is no pagination; the
   dashboard shows a truncation notice when the organization count is larger.
10. **Service-role scope is minimal.** It can INSERT waitlist rows and has the
    default non-DML grants, but it cannot SELECT waitlist rows. Future server
    features need explicit, reviewed grants.
