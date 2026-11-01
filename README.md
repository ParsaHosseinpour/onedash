# OneDash

OneDash is an early-stage uptime-monitoring product. The current branch adds a
versioned Supabase database foundation with tenant isolation, RLS, a hardened
waitlist, account bootstrap, pgTAP tests, a tenant-safe monitor configuration
UI, and a standalone Phase 4A.1 HTTP/HTTPS checker foundation. The checker now
rejects HTTPS-to-HTTP redirect downgrades, retries a bounded set of validated
addresses before any response, and has local trusted-TLS coverage. The
cookie-based auth flow has been verified manually in a browser; automated
Playwright E2E is
still missing. It is **not yet an uptime monitor**: the checker is not wired to
a scheduler or database, there is no alert sender or deployed public status
page, and saved monitor configurations are not being checked. See
[`ROADMAP.md`](./ROADMAP.md), [`docs/database.md`](./docs/database.md), and
[`worker/README.md`](./worker/README.md).

## Stack

- Next.js 16 (App Router, Turbopack, `proxy.ts`)
- React 19
- TypeScript
- Tailwind CSS 4
- Supabase Auth, Postgres, RLS, and the Supabase CLI
- `undici` for the pinned HTTP transport and `ipaddr.js` for IP policy
- Vitest + Testing Library
- pgTAP database tests

## Requirements

- Node.js **20.19+**, **22.12+**, or **24+** (CI uses Node 24)
- npm (the repo has a `package-lock.json`)
- Docker Desktop for the local Supabase stack
- Supabase CLI **2.122.0** (installed as a dev dependency; use `npm run db:*`)

## Local setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Start the local Supabase stack:

   ```bash
   npm run db:start
   ```

   The project id is `onedash`. Windows reserves `54226-54325`, so this repo
   uses the `544xx` range:

   | Service | URL / port |
   | --- | --- |
   | API / REST | `http://127.0.0.1:54421` |
   | Postgres | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
   | Studio | `http://127.0.0.1:54423` |
   | Mailpit | `http://127.0.0.1:54424` |
   | Analytics | `54427` |

3. Apply migrations and seed data:

   ```bash
   npm run db:reset
   ```

   `db:reset` drops the local database, applies every file in
   `supabase/migrations/`, and loads `supabase/seed.sql`. It does not touch a
   remote project.

4. Copy the local API values into `.env.local`:

   ```bash
   npm run db:status
   ```

   Then create `.env.local` with:

   ```dotenv
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54421
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from db:status>
   NEXT_PUBLIC_SITE_URL=http://localhost:3000
   SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from db:status>
   ```

   `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never prefix it with
   `NEXT_PUBLIC_`, expose it to the browser, log it, or commit it. The waitlist
   route needs it because anon/authenticated no longer have INSERT on
   `public.waitlist`.

5. Start the app:

   ```bash
   npm run dev
   ```

   Open <http://localhost:3000>. Confirmation emails from local signup appear in
   Mailpit at <http://localhost:54424>.

### Seed accounts

The seed creates two organizations and six confirmed local users. All use the
password `onedash-dev-password1`.

| User | Organization | Role |
| --- | --- | --- |
| `owner@acme.test` | Acme Monitoring | owner |
| `admin@acme.test` | Acme Monitoring | admin |
| `member@acme.test` | Acme Monitoring | member |
| `viewer@acme.test` | Acme Monitoring | viewer |
| `owner@globex.test` | Globex Status | owner |
| `admin@globex.test` | Globex Status | admin |

Acme has a published status page (`acme-status`) with one active, selected
monitor. Globex has an unpublished page. The seed also creates monitors,
schedules, check results, incidents, alert channels, encrypted placeholder
secrets, and an alert delivery.

## Database workflow

| Command | Purpose |
| --- | --- |
| `npm run db:start` | Start the local Supabase stack. |
| `npm run db:stop` | Stop the local stack. |
| `npm run db:status` | Show local URLs and keys. |
| `npm run db:reset` | Recreate the database from migrations and seed. |
| `npm run db:test` | Run the pgTAP suite against the local database. |
| `npm run db:lint` | Lint `public` and `extensions` functions. |

Migrations are the source of truth. `supabase/schema.sql` is the Phase 1
historical waitlist file; it is retained for reference and must not be applied
after the migrations. The waitlist migration intentionally changes its grants
to close the direct anon PostgREST INSERT bypass.

The current suite has **211 pgTAP assertions** across seven files:

- `001_schema_invariants.sql` — RLS coverage, indexes, constraints, function
  hardening, default privilege removal, and waitlist privileges.
- `002_tenant_isolation.sql` — anon denial, same-org access, other-org denial,
  owner/admin/member/viewer permissions, last-owner invariant, bootstrap
  idempotency, and worker grants.
- `003_constraints_and_waitlist.sql` — monitor/schedule/result/incident
  constraints, idempotency, waitlist validation, and the service-role write
  path.
- `004_public_status_pages.sql` — published-only public views, active/selected
  monitor filtering, and unpublish/deactivate behavior.
- `005_monitor_management.sql` — monitor RLS and role enforcement, cross-tenant
  denial, the protected development limit, and the per-organization advisory
  lock.
- `006_checker_contract.sql` — Phase 4A monitor restrictions and the extended
  sanitized `check_results.error_class` vocabulary.
- `007_check_result_metrics.sql` — Phase 4A.1 `redirect_count` /
  `response_bytes` defaults, non-negative constraints, and tenant isolation.

The tests run against the seeded local database. They create their own users
and organizations inside a transaction and roll back, and they scope assertions
to test-specific slugs and IDs so seed data does not make counts ambiguous.

See [`docs/database.md`](./docs/database.md) for the ERD, role matrix, RLS
helpers, worker role, retention/partition plan, and known deviations.

## Application commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run build` | Production build and type check. |
| `npm start` | Serve the production build. |
| `npm run lint` | Run ESLint. |
| `npm run typecheck` | Run `tsc --noEmit`. |
| `npm test` | Run Vitest once. |
| `npm run test:checker` | Run only the Phase 4A.1 checker tests. |
| `npm run test:watch` | Run Vitest in watch mode. |

## Checker foundation (Phase 4A.1)

`worker/checker/` is a standalone TypeScript checker with no Next.js request
handler imports and no database client. It validates absolute HTTP/HTTPS URLs,
resolves every DNS answer, rejects mixed public/private answers, pins one
validated address per attempt, preserves the hostname for the Host
header/SNI/certificate verification, keeps TLS verification enabled, and
revalidates every redirect hop. Responses are read only up to a byte cap and
discarded.

Phase 4A.1 adds:

- HTTPS-to-HTTP redirect downgrades are rejected as `redirect_failure`.
  HTTP-to-HTTPS and HTTPS-to-HTTPS redirects remain allowed. The rule is applied
  to every hop and has no opt-out.
- If a hostname resolves to multiple validated addresses, the checker tries at
  most three. Only pre-response connection refused/failure or timeout is retried.
  TLS errors and returned HTTP statuses are not retried. The total deadline is
  unchanged, and every attempt keeps the original hostname for TLS SNI and
  certificate verification.
- Local TLS tests use disposable certificates generated at runtime. They cover a
  trusted test CA, wrong-hostname rejection, self-signed rejection, SNI/Host
  preservation, IPv6 loopback where available, and a real `checkMonitor` +
  Undici + local TLS server path. A missing OpenSSL CLI, missing Node test-CA
  API, or an environment that cannot bind `::1` skips the affected tests
  explicitly rather than reporting a false pass.
- The new `20261101090000_check_result_metrics.sql` migration persists
  `redirect_count` and `response_bytes`. Ingestion itself is still Phase 4B work.

It is also tested with injected DNS/transport fakes and local loopback
HTTP/HTTPS servers, including decimal/hex IP forms, IPv4-mapped IPv6, DNS
rebinding, redirect-to-private, timeout, cancellation, size-cap, and redaction
cases. Run `npm run test:checker`.

Before applying the stricter Phase 4A monitor migration to an existing database,
run the read-only
[`supabase/preflight/phase_4a_monitor_compatibility.sql`](./supabase/preflight/phase_4a_monitor_compatibility.sql)
check. It reports blocking monitor rows and rolls back; it does not delete,
disable, or rewrite monitors. See [`worker/README.md`](./worker/README.md).

This is a foundation, not a running monitoring service. There is no scheduler,
worker service, result ingestion, or customer check. Before Phase 4B, the worker
host must enforce egress isolation for private, link-local, loopback, metadata,
control-plane, and Supabase private networks. Application validation alone is
not sufficient; if the hosting environment cannot enforce it, enabling customer
checks is a release blocker. See [`worker/README.md`](./worker/README.md).

## Environment behavior

- The landing page builds and renders without Supabase environment variables.
- Auth pages show a configuration notice when Supabase is absent; the waitlist
  API and auth callback return friendly `503` responses and log which variable
  is missing. Static marketing content is never broken by missing auth
  configuration.
- `NEXT_PUBLIC_SITE_URL` is mandatory in production. It prevents the auth
  callback from deriving redirects from an untrusted `Host` header. Local
  development falls back to `http://localhost:3000`.
- The waitlist route fails closed when `SUPABASE_SERVICE_ROLE_KEY` is missing.

## Authentication design

- The browser uses `createBrowserClient` from `@supabase/ssr`, so the session is
  stored in cookies rather than `localStorage`.
- Login and signup submit to Server Actions. The server writes the session
  cookies, which `/dashboard` reads on the next request.
- `src/proxy.ts` (formerly `middleware.ts`) refreshes expired tokens. It is an
  optimistic convenience only; `/dashboard` calls `requireUser()`, which
  verifies the user with Supabase Auth before rendering.
- Logout is a Server Action. It revokes the session and explicitly deletes
  Supabase auth cookies, including chunked cookies and the PKCE verifier.
- Signup returns the same accepted response for new and already-registered
  addresses, so it cannot be used to enumerate accounts. Supabase Auth rate
  limits are translated into a friendly "try again later" message.
- Post-login redirects only allow `/dashboard`. External, protocol-relative,
  backslash, and encoded redirects fall back to `/dashboard`.
- Account bootstrap is idempotent: an `auth.users` INSERT trigger creates a
  profile and a personal organization only when the user has no membership.
  Re-running `ensure_my_account()` does not create duplicate organizations.

### Manual auth verification

The browser/cookie flow was verified manually against the local stack on
2026-10-28: signup, Mailpit confirmation, callback, dashboard, refresh, logout,
logged-out `/dashboard` redirect, login, and logged-in `/login` + `/signup`
redirects all passed. Auth cookies were present while signed in and cleared on
logout; `localStorage` stayed empty.

Automated Playwright E2E is still missing. Re-run this checklist after auth
changes:

1. Sign up at `/signup` with a new email and a strong password.
2. Open Mailpit at <http://localhost:54424>, follow the confirmation link, and
   verify it lands on `/auth/callback` and redirects to `/dashboard`.
3. Log out, then log in at `/login`; `/dashboard` shows the email.
4. Visit `/dashboard` in a logged-out browser; it redirects to `/login`.
5. Log out; `/dashboard` is no longer accessible and a server request after
   logout is rejected.
6. Refresh `/dashboard` while logged in; the session survives.

Unit tests mock Supabase and do not replace this browser check.

## Monitor management

Phase 3 adds the authenticated control plane for HTTP/HTTPS monitor
configuration. It does **not** run checks.

- Routes: `/dashboard` (list and count), `/dashboard/monitors/new`,
  `/dashboard/monitors/[id]` (detail), and `/dashboard/monitors/[id]/edit`.
- First-release fields: name, URL, `GET`/`HEAD`, expected status code(s),
  interval in minutes (default 5), timeout in seconds, active/paused state, and
  timestamps.
- Every read and mutation resolves the organization and role from the
  authenticated user's membership on the server. The browser never supplies an
  organization id, user id, role, ownership flag, or plan limit.
- Owners, admins, and members can create, edit, pause/resume, and delete.
  Viewers are read-only. RLS and database constraints remain the final
  boundary; the cookie-scoped anon/authenticated client is used instead of the
  service-role key.
- URLs must be absolute `http`/`https` URLs with a hostname, no embedded
  credentials, and only ports 80/443. Localhost and obvious private, loopback,
  link-local, and metadata addresses are rejected at configuration time. This
  is not the Phase 4 SSRF boundary: the checker must still resolve and
  revalidate every address and redirect hop before any outbound request.
- Expected status accepts a single code (`200`), a comma list (`200, 204`), or
  an inclusive range (`200-204`), capped at 20 codes. Intervals are 1–1,440
  minutes; timeouts are 1–60 seconds and must be shorter than the interval.
- Deleting requires typing the exact monitor name. The server re-reads the name
  from the database before deleting.
- The development limit defaults to **25 monitors per organization** and is
  stored in `public.monitor_limit_settings`. It is enforced by a
  `BEFORE INSERT` trigger with a per-organization advisory lock, so concurrent
  server actions and direct PostgREST inserts cannot bypass it. This is a
  development guard, not a billing or plan entitlement. Operators can change
  it with SQL; see [`docs/database.md`](./docs/database.md).
- The list is capped at 200 rows and shows a notice when the organization count
  is larger. There is no pagination yet.
- No check status, latency, uptime, or history is synthesized. The UI shows a
  last-check timestamp only when `monitor_state` already contains one; new
  monitors show “No checks recorded.” The global notice states that monitoring
  execution is not active.
- Monitor DTOs select an explicit safe column list. Scheduler fields, encrypted
  request secrets, worker credentials, and ciphertext are never returned to the
  browser.

## Waitlist security

- `/api/waitlist` validates and normalizes email addresses, enforces a source
  allowlist, and uses a hidden honeypot field.
- The database enforces length/format constraints, a case-insensitive unique
  index, `NOT NULL` timestamps, and a `landing_page` source allowlist.
- Anon and authenticated have **no** table privileges on `public.waitlist`.
  They cannot INSERT, SELECT, UPDATE, or DELETE rows through PostgREST. The
  direct-insert bypass from Phase 1 is closed.
- The trusted server route uses the server-only `SUPABASE_SERVICE_ROLE_KEY` to
  INSERT normalized rows. `service_role` has INSERT only and cannot SELECT
  waitlist emails.
- `waitlist_count()` is `SECURITY DEFINER`, uses an empty `search_path`, and is
  callable by anon/authenticated so the UI can show an aggregate count without
  reading individual rows.
- Rate limiting is still an **in-process fixed window** (5 submissions per IP
  per 10 minutes). It is per instance, not shared, and resets on restart. A
  shared limiter (Redis/Upstash or a WAF) is still required before a
  multi-instance public launch.

## Security headers

`next.config.ts` sets `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`, disables `X-Powered-By`, and adds HSTS
in production. A strict CSP is intentionally deferred until the production
script/style surface is finalized; do not treat the current headers as a
complete CSP replacement.

## Project layout

```text
src/
  app/
    actions/auth.ts          server actions for login, signup, logout
    actions/monitors.ts      authenticated monitor CRUD/pause/delete actions
    api/waitlist/route.ts    server-side waitlist endpoint
    auth/callback/route.ts   email confirmation callback
    components/              marketing nav, waitlist form, config notice
    dashboard/               monitor list, detail, create/edit, states
    login/, signup/          auth pages and forms
  lib/
    auth.ts                  requireUser + cookie clearing
    auth-validation.ts       password and redirect allowlist rules
    email.ts                 email normalization
    env.ts                   lazy environment validation
    monitor-config.ts        client-safe DTOs, constants, formatters
    monitor-validation.ts    URL/status/interval/timeout validation
    monitor-repository.ts    explicit-column data access through RLS
    monitor-service.ts       membership, role, limit, delete rules
    rate-limit.ts            in-process limiter (documented limitation)
    server-guard.ts          runtime server-only import guard
    supabase/                server and proxy Supabase clients
    supabase-client.ts       cookie-based browser client
    waitlist-service.ts      testable waitlist submission logic
  proxy.ts                   Next.js 16 session-refresh proxy
supabase/
  config.toml                local ports, auth, seed settings
  migrations/                versioned schema and RLS migrations
  seed.sql                   two-org local development seed
  tests/database/            pgTAP RLS, constraint, and privilege tests
  preflight/                 read-only Phase 4A migration compatibility check
  schema.sql                 legacy Phase 1 waitlist file (do not re-apply)
docs/database.md             ERD, role matrix, RLS and retention notes
tests/                       Vitest unit/integration and component tests
tests/checker/               Phase 4A.1 checker tests and runtime TLS fixtures
worker/
  checker/                   standalone HTTP/HTTPS checker (no Next.js imports)
  README.md                  checker contract, limits, egress, Phase 4B notes
```

## CI

`.github/workflows/ci.yml` has two jobs:

- **verify** — `npm ci`, lint, type check, Vitest, production build without
  Supabase credentials, and `npm audit --omit=dev`.
- **database** — Supabase CLI 2.122.0, `supabase start`, `supabase db reset`,
  `supabase test db --local`, and `supabase db lint --local --level warning`.

The workflow does not deploy or push anything. The `phase-1/**`, `phase-2/**`,
`phase-3/**`, `phase-4/**`, and `phase-4a/**` branch patterns are included in
the push filter.

## Verification status

Verified locally on 2026-11-01:

| Check | Result |
| --- | --- |
| `npm run lint` | Pass, no findings |
| `npm run typecheck` | Pass |
| `npm test` | 331 tests across 25 files pass |
| `npm run test:checker` | 160 checker tests across 7 files pass |
| `npm run build` (no Supabase env) | Pass |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run db:reset` | 8 migrations + seed pass |
| `npm run db:test` | 211 assertions across 7 files pass |
| `npm run db:lint` | No schema errors |
| Phase 4A preflight (read-only, local) | 3 monitors, 0 blocking, 0 unexpected error classes |

Browser/cookie auth E2E passed manually on 2026-10-28; it is not yet automated in CI. Use the manual checklist above after auth changes. Monitor management is covered by Vitest service/action/component tests and pgTAP RLS/limit tests; it has not been added to an automated browser suite. Phase 4A.1 checker coverage is application-level plus local TLS; it does not prove production TLS against a publicly trusted CA or deployment egress isolation, which remain release gates.

## Known gaps before Phase 4B

- Auth E2E is manual only; no Playwright suite runs in CI. Re-run the manual
  checklist above after auth changes.
- Monitoring execution is not wired up. Phase 4A.1 provides a standalone checker
  and result-metric columns, but there is no scheduler, worker service,
  test-check action, result ingestion, alert delivery, or public status-page UI.
  Saved configurations are not checked.
- The Phase 4A.1 TLS suite does not prove production TLS against a publicly
  trusted CA, a corporate proxy, a custom trust store, or a host with clock skew.
  IPv6 routing and dual-stack fallback are unverified. These remain deployment
  smoke tests.
- The old disposable test private key remains in git history at the Phase 4A
  commit, even though it was removed from the current tree. Secret scanners that
  inspect history may still flag it. History was not rewritten; it was never a
  production credential.
- The migration preflight has only been run against the local seeded database.
  It has not been run against a remote, staging, or production database, and no
  remote database has been linked, modified, or reset.
- Application-level SSRF validation and DNS pinning exist in the checker, but
  egress isolation is a deployment requirement and is not configured by this
  repository. The worker host must deny private, link-local, loopback, metadata,
  control-plane, and Supabase private-network egress. If it cannot, customer
  checks are a release blocker.
- The worker role is a global scheduler role: it can read monitoring and
  alerting rows across tenants, but not profiles, organizations, audit logs, or
  status pages. Phase 4B must split checker/scheduler/ingestor permissions and
  keep secrets away from the checker.
- The monitor limit is a development guard, not plan/billing enforcement.
  There is no Stripe integration or entitlement model.
- The monitor list is capped at 200 rows with no pagination. The database limit
  is operator-configurable up to 10,000.
- `check_results` is not partitioned and no rollup tables exist. Retention and
  partitioning are documented, not implemented.
- The waitlist limiter is per-instance, not shared.
- No remote Supabase project has been linked or pushed.
