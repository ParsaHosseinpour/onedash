# OneDash

OneDash is an early-stage uptime-monitoring product. The current branch adds a
versioned Supabase database foundation with tenant isolation, RLS, a hardened
waitlist, account bootstrap, and pgTAP tests. The cookie-based auth flow has
been verified manually in a browser; automated Playwright E2E is still missing.
It is **not yet an uptime monitor**: there is no monitor CRUD UI, scheduler,
checker, alert sender, or deployed public status page. See
[`ROADMAP.md`](./ROADMAP.md) and [`docs/database.md`](./docs/database.md).

## Stack

- Next.js 16 (App Router, Turbopack, `proxy.ts`)
- React 19
- TypeScript
- Tailwind CSS 4
- Supabase Auth, Postgres, RLS, and the Supabase CLI
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

The current suite has **150 pgTAP assertions** across four files:

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
| `npm run test:watch` | Run Vitest in watch mode. |

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
    api/waitlist/route.ts    server-side waitlist endpoint
    auth/callback/route.ts   email confirmation callback
    components/              marketing nav, waitlist form, config notice
    dashboard/               protected placeholder
    login/, signup/          auth pages and forms
  lib/
    auth.ts                  requireUser + cookie clearing
    auth-validation.ts       password and redirect allowlist rules
    email.ts                 email normalization
    env.ts                   lazy environment validation
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
  schema.sql                 legacy Phase 1 waitlist file (do not re-apply)
docs/database.md             ERD, role matrix, RLS and retention notes
tests/                       Vitest unit/integration tests
```

## CI

`.github/workflows/ci.yml` has two jobs:

- **verify** — `npm ci`, lint, type check, Vitest, production build without
  Supabase credentials, and `npm audit --omit=dev`.
- **database** — Supabase CLI 2.122.0, `supabase start`, `supabase db reset`,
  `supabase test db --local`, and `supabase db lint --local --level warning`.

The workflow does not deploy or push anything. The `phase-2/**` branch pattern
is included in the push filter.

## Verification status

Verified locally on 2026-10-28:

| Check | Result |
| --- | --- |
| `npm run lint` | Pass, no findings |
| `npm run typecheck` | Pass |
| `npm test` | 72 tests across 11 files pass |
| `npm run build` (no Supabase env) | Pass |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run db:reset` | 5 migrations + seed pass |
| `npm run db:test` | 150 assertions across 4 files pass |
| `npm run db:lint` | No schema errors |

Browser/cookie auth E2E passed manually on 2026-10-28; it is not yet automated in CI. Use the manual checklist above after auth changes.

## Known gaps before Phase 3

- Auth E2E is manual only; no Playwright suite runs in CI. Re-run the manual
  checklist above after auth changes.
- The worker role is a global scheduler role: it can read monitoring and
  alerting rows across tenants, but not profiles, organizations, audit logs, or
  status pages. This is a documented deviation from the roadmap's literal
  "cannot read unrelated tenants" wording.
- `check_results` is not partitioned and no rollup tables exist. Retention and
  partitioning are documented, not implemented.
- The waitlist limiter is per-instance, not shared.
- No remote Supabase project has been linked or pushed.
- Monitor CRUD, scheduling, checking, alert delivery, and public status-page UI
  are Phase 3+ work.
