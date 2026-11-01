# OneDash Roadmap

**Status:** Phase 4A.1 reliability and TLS hardening implemented on `phase-4a/safe-http-checker` — 2026-11-01. Phase 3 monitor configuration remains verified. Phase 4A.1 adds HTTPS-downgrade rejection, bounded validated-address fallback, local trusted-TLS tests, persisted redirect/response-size metrics, a read-only migration preflight, and removal of the committed test private key. The checker is standalone and independently tested, but it is **not wired to a scheduler or database**: there is no worker service, test-check action, result ingestion, alert delivery, or customer check. Phase 4B (scheduling, worker service, ingestion, regions, metrics) has not started. Hosting egress isolation is an explicit release blocker for customer checks.
**First release scope:** real HTTP/HTTPS uptime monitoring
**Phase 0 rule (historical):** audit only. No application behavior, SQL schema, dependency, or deployment configuration was changed.
**Phase 2 rule:** database foundation only. No monitor UI, scheduler, checker, alert sender, deployment, or remote `db push` was added.

OneDash is currently a Next.js marketing site with a Supabase waitlist, a cookie-based auth foundation, a versioned tenant-safe database schema, an authenticated monitor-configuration control plane, and a standalone Phase 4A.1 checker foundation. It is **not yet an uptime monitor**: no customer check is scheduled or executed, and there is no scheduler, worker service, result ingestion, or alert delivery. The phases below are ordered so that authentication, tenant isolation, and outbound-request safety are fixed before monitoring is built.

## Verification snapshot (2026-10-28)

Phase 2 was verified on a fresh local database with Supabase CLI 2.122.0, Docker Desktop, and Node 24.

| Check | Command | Actual result |
|---|---|---|
| Lint | `npm run lint` | Pass, no findings |
| Type check | `npm run typecheck` | Pass |
| Unit/integration tests | `npm test` | Pass: 11 files, 72 tests |
| Production build (no Supabase env) | `npm run build` | Pass; no `middleware` deprecation warning |
| Runtime dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Migrations from empty | `npm run db:reset` | Pass: 5 migrations + seed |
| Database/RLS tests | `npm run db:test` | Pass: 4 files, 150 assertions |
| Database lint | `npm run db:lint` | Pass: no schema errors |
| Security headers | `npm start` + HTTP request | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS present; no `X-Powered-By` |
| Client-bundle secret scan | Search `.next/static` | No `SUPABASE_SERVICE_ROLE_KEY` or `service_role` references |
| Browser auth E2E | Manual Chrome flow: signup → Mailpit confirmation → callback → dashboard → refresh → logout → login | **Pass** (manual, 2026-10-28); not automated in CI |

Manual browser evidence (2026-10-28): a new local user was created, confirmed through Mailpit, and landed on `/dashboard`. Refreshing kept the session. Logout cleared all auth cookies and redirected to the landing page; `/dashboard` then redirected to `/login`. Logging in again worked, and `/login` and `/signup` both redirected an authenticated user to `/dashboard`. `localStorage` stayed empty throughout; auth cookies were present while signed in and absent after logout.

## Phase 3 verification snapshot (2026-10-28)

| Check | Command | Actual result |
|---|---|---|
| Lint | `npm run lint` | Pass, no findings |
| Type check | `npm run typecheck` | Pass |
| Unit/integration/component tests | `npm test` | Pass: 18 files, 171 tests |
| Production build (no Supabase env) | `npm run build` | Pass; monitor routes are dynamic |
| Runtime dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Migrations from empty | `npm run db:reset` | Pass: 6 migrations + seed |
| Database/RLS/limit tests | `npm run db:test` | Pass: 5 files, 188 assertions |
| Database lint | `npm run db:lint` | Pass: no schema errors |
| Browser monitor UI | Manual browser pass | Not run in this verification pass; covered by component/action/service tests and the production build |

The monitor UI has empty, loading, error, and success states; keyboard-operable forms and a focusable delete dialog; disabled pending controls; and a global notice that monitoring execution is inactive. No live customer HTTP request was made.

## Phase 4A verification snapshot (2026-10-31)

Phase 4A was verified locally with Supabase CLI 2.122.0, Docker Desktop, and Node 24.

| Check | Command | Actual result |
|---|---|---|
| Lint | `npm run lint` | Pass, no findings |
| Type check | `npm run typecheck` | Pass |
| Unit/integration/component tests | `npm test` | Pass: 24 files, 315 tests |
| Checker-only tests | `npm run test:checker` | Pass: 6 files, 144 tests |
| Production build (no Supabase env) | `npm run build` | Pass |
| Runtime dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Migrations from empty | `npm run db:reset` | Pass: 7 migrations + seed |
| Database/RLS/checker-contract tests | `npm run db:test` | Pass: 6 files, 201 assertions |
| Database lint | `npm run db:lint` | Pass: no schema errors |

The checker tests use injected DNS/transport fakes and local loopback HTTP/HTTPS servers. No arbitrary external website is required. Deployment-level egress isolation was **not** verified and remains a release blocker for customer checks.

## Phase 4A.1 verification snapshot (2026-11-01)

Phase 4A.1 was verified locally with Supabase CLI 2.122.0, Docker Desktop, and Node 24.

| Check | Command | Actual result |
|---|---|---|
| Lint | `npm run lint` | Pass, no findings |
| Type check | `npm run typecheck` | Pass |
| Unit/integration/component tests | `npm test` | Pass: 25 files, 330 tests |
| Checker-only tests | `npm run test:checker` | Pass: 7 files, 159 tests |
| Production build (no Supabase env) | `npm run build` | Pass |
| Runtime dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Migrations from empty | `npm run db:reset` | Pass: 8 migrations + seed |
| Database/RLS/checker-contract tests | `npm run db:test` | Pass: 7 files, 211 assertions |
| Database lint | `npm run db:lint` | Pass: no schema errors |
| Migration preflight | Read-only local run against the seeded database | 3 monitors, 0 blocking, 0 unexpected error classes |

The TLS tests generate disposable certificates at runtime and add the test CA to the Node trust store without disabling verification. A missing OpenSSL CLI, a Node runtime without the test-CA API, or an environment that cannot bind `::1` causes the affected tests to be reported as skipped/blocked, not passed. No arbitrary external website is used. No remote database was connected to, modified, or reset. Deployment-level egress isolation remains **unverified** and a release blocker for customer checks.

---

## 1. Executive summary

### What exists

- A polished static landing page with marketing sections, pricing copy, and waitlist CTA.
- A Supabase-backed waitlist insert/count flow with server-side validation and rate limiting.
- Supabase email/password signup and login UI with cookie-based SSR sessions.
- A server-side email-confirmation callback (`/auth/callback`).
- A protected `/dashboard` with tenant-scoped monitor configuration: list, detail, create, edit, pause/resume, and delete.
- A standalone Phase 4A HTTP/HTTPS checker foundation with SSRF/DNS-rebinding defenses and independent tests; it is not wired to the app.
- Versioned migrations, RLS, seed data, pgTAP database tests, Vitest tests, and CI.

### What does not exist

- Scheduler, worker service, check-result ingestion, customer checks, alert delivery, operational incident/status-page management, teams/invitations, billing, or public APIs. The Phase 4A checker module exists but is not connected to any of these.
- Automated Playwright auth or monitor E2E coverage.
- A deployed, production-ready data plane with enforced worker egress isolation.

### Release-blocking findings (Phase 0 baseline; see status above)

> Items 1–3 were addressed in Phase 1. They are retained as historical audit
> findings. Item 4 is only partially addressed: Phase 4A adds a tested checker
> foundation, but the scheduler, worker service, ingestion, and enforced egress
> isolation are still absent. Item 5 remains true for the unimplemented
> monitoring, alerting, and status-page claims.

1. **Authentication is inconsistent and likely broken in a clean browser.** The browser client uses `@supabase/supabase-js` (`localStorage` session), while the server and middleware use `@supabase/ssr` cookie sessions. Password login does not create the cookies the server reads, and logout does not clear server cookies. See §5.1.
2. **`next@16.2.10` has a critical security advisory.** `npm audit` recommends `next@16.4.3` or later. See §4.
3. **A clean production build fails without Supabase environment variables.** The landing page imports a browser module that throws during prerender. See §4.
4. **The monitoring data plane is not operational.** Phase 4A provides only a standalone checker module; the scheduler, worker service, result ingestion, and enforced worker egress isolation are absent. A Next.js/Vercel deployment must not be used as the scheduler or checker. See §6.
5. **Marketing claims are ahead of the implementation.** Ping/TCP/cron monitoring, multi-region checks, alerts, status pages, teams, and pricing tiers do not exist yet. See §3.

---

## 2. Repository state

> **Historical baseline:** Sections 2–5 describe the Phase 0 audit snapshot from 2026-10-26 and are intentionally preserved. They no longer describe the current branch; see the verification snapshot above and the Phase 1/2 status below.

| Item | Finding |
|---|---|
| Project root | `C:\Users\rozit\Downloads\onedash-main\onedash-main` (the supplied folder is nested one level) |
| Version control | **No git repository.** `git status` and `git rev-parse --show-toplevel` fail with `fatal: not a git repository`. There is no tracked-file list, commit history, or diff available. |
| File inventory | 33 non-generated files: 17 under `src`, 1 SQL file, 5 default public SVGs, 10 root config/doc files |
| Framework | Next.js `16.2.10` (Turbopack is the default build/dev engine) |
| UI | React `19.2.4`, Tailwind CSS `4.3.2`, TypeScript `5.9.3` |
| Auth/data | `@supabase/ssr@0.12.5`, `@supabase/supabase-js@2.112.4` (installed) |
| Database | One table (`public.waitlist`), one insert policy, one `SECURITY DEFINER` count function |
| Tests | None |
| CI/CD | None |
| Environment files | None; there is no `.env.example` or committed setup guide |
| Node used for audit | `v24.15.0`; npm `11.12.1` |
| Generated by audit | `node_modules/`, `.next/`, `next-env.d.ts` (all ignored by `.gitignore`) |

Condensed tree:

```text
src/app/
  page.tsx                     landing page
  layout.tsx, globals.css
  components/NavBar.tsx
  components/WaitlistForm.tsx
  login/{page.tsx,LoginForm.tsx}
  signup/{page.tsx,SignupForm.tsx}
  dashboard/{page.tsx,LogoutButton.tsx}
  auth/callback/route.ts
src/lib/supabase-client.ts      browser client (localStorage)
src/lib/supabase/server.ts      server cookie client
src/lib/supabase/middleware.ts  middleware cookie client
src/middleware.ts               session refresh (deprecated convention)
supabase/schema.sql             waitlist table + RLS
```

Because there is no `.git`, this audit is based on a complete filesystem inventory, not on Git-tracked files. Establishing version control should be the first task in Phase 1.

---

## 3. Baseline feature inventory

Status meanings: **Implemented** = code exists and is plausibly functional; **Scaffolded** = code exists but end-to-end behavior is unverified or incomplete; **Placeholder** = static UI only; **Missing** = not present.

| Area | Status | Baseline details |
|---|---|---|
| Landing page | Implemented (static) | Hero, feature cards, pricing cards, waitlist CTA, footer. Self-contained in `src/app/page.tsx`. |
| Marketing status pill | Placeholder | "All systems operational" is hard-coded; there is no status system behind it. |
| Footer links | Placeholder | GitHub, Twitter, and Privacy all point to `#`. |
| NavBar auth awareness | Scaffolded | Client component uses `supabase.auth.getSession()` from a localStorage client; can disagree with server auth. |
| Waitlist form | Scaffolded | Inserts `email` and calls `waitlist_count()`. No server-side validation, rate limit, CAPTCHA, or case-insensitive uniqueness. Not tested against a live schema. |
| Waitlist database security | Partially implemented | RLS enabled; anonymous INSERT allowed with `WITH CHECK (true)`; count exposed through a `SECURITY DEFINER` function. No select/delete policies, which is intentional. |
| Signup UI | Scaffolded | Email/password signup, minimum 6-character client-side check, confirmation email redirect to `/auth/callback`. |
| Signup server validation | Missing | No server action, schema validation, password-strength policy, or bot protection. Raw Supabase errors are shown. |
| Email confirmation callback | Implemented (unverified) | Exchanges `code` for a server session and redirects to `/dashboard`; falls back to `/login?error=auth_callback_failed`. |
| Password login | **Broken by static analysis** | Browser writes a localStorage session; server reads cookies. A clean browser cannot establish the server session. See §5.1. |
| Logout | **Incomplete** | Browser `signOut()` does not clear the Supabase SSR cookies; a server session can outlive the UI logout until token expiration. |
| Session refresh | Implemented (deprecated) | `src/middleware.ts` calls `getUser()` on most requests. Next.js 16 deprecates `middleware` in favor of `proxy`. |
| Route protection | Partially implemented | `/dashboard` checks `getUser()` and redirects. Login/signup redirect authenticated users. No shared data-access layer or proxy-level optimistic protection. |
| Dashboard | Placeholder | Welcome message, "0 monitors", "no incidents", and a "status page arrives in v0.7" card. No real data. |
| Monitor CRUD | Missing | No table, API, server action, or UI. |
| Scheduler/worker | Missing | No queue, cron, or long-running process. |
| HTTP/HTTPS checker | Missing | No outbound check implementation, timeout policy, redirect policy, or SSRF protection. |
| Check-result storage | Missing | No `check_results` table or retention strategy. |
| Incident state machine | Missing | No failure thresholds, confirmation, recovery, or incident timeline. |
| Alerting | Missing | No email, Discord, Telegram, webhook, SMS, delivery log, retry, or dedupe. |
| Status pages | Missing | No public page, branding, slug, or custom domain. |
| Teams / organizations | Missing | No org, membership, roles, or invitations. |
| Billing / plans | Missing | Pricing is marketing copy only; no Stripe, entitlements, or usage limits. |
| Multi-region checks | Missing | No regions, quorum, or confirmation policy. |
| Ping/TCP/cron monitoring | Missing | Claimed on the landing page; out of scope for the first HTTP/HTTPS release. |
| Tests / CI | Missing | No unit, integration, RLS, or E2E tests; no workflow files. |
| Migrations | Missing | One manually pasted `schema.sql`; no migration history or local Supabase workflow. |
| Observability | Missing | No structured logs, metrics, tracing, error tracking, or worker heartbeat. |
| Security headers | Missing | `next.config.ts` is empty; no CSP, HSTS, frame-ancestors, or related headers. |
| Legal pages | Missing | No Terms, Privacy, DPA, or acceptable-use policy. |
| Docs | Placeholder | README is the default create-next-app text; `AGENTS.md` contains only the Next.js agent rule; `CLAUDE.md` points to `AGENTS.md`. |

Version labels are inconsistent: `package.json` says `0.1.0`, the schema header says `v0.2`, the UI says `v0.3`, and the footer says `v0.1`. Pick one release scheme in Phase 1.

---

## 4. Verification baseline

### Commands run

| Command | Result | Notes |
|---|---|---|
| `npm ci` | Pass | 371 packages installed; audit reported 10 vulnerabilities. |
| `npm run lint` | Pass | ESLint CLI completed with no findings. |
| `npm run build` (no env) | **Fail** | Prerender of `/` throws `Missing Supabase env vars...` from `src/lib/supabase-client.ts`. |
| `npm run build` (placeholder public env) | Pass | Compiles, type-checks, and prerenders all 8 pages. Build warns that `middleware` is deprecated. |
| Production smoke test | Partial pass | With an unreachable local Supabase URL: `/`, `/login`, `/signup` = 200; `/dashboard` = 307 to `/login`; `/auth/callback` with no code = 307 to `/login?error=auth_callback_failed`. |
| `npm audit` | **Fail** | 1 critical, 8 high, 1 moderate. |

The build success above used throwaway values only; no live Supabase request was made. The production smoke test used `http://127.0.0.1:9` to force fast connection failures.

### Build output

```text
Next.js 16.2.10 (Turbopack)

⚠ The "middleware" file convention is deprecated.
  Please use "proxy" instead.

Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /auth/callback
├ ƒ /dashboard
├ ƒ /login
└ ƒ /signup

ƒ Proxy (Middleware)
```

`next build` no longer runs linting in Next.js 16; `npm run lint` is the separate ESLint CLI. TypeScript is checked during the build.

### Dependency audit

`npm audit` currently reports:

| Severity | Count | Notable packages |
|---|---:|---|
| Critical | 1 | `next` (direct; fixed by `next@16.4.3`+) |
| High | 8 | `brace-expansion`, `browserslist`, `js-yaml`, `nanoid`, `postcss`, `sharp`, `source-map-js`, `zod` |
| Moderate | 1 | `baseline-browser-mapping` |

`next@16.2.10` is inside the advisory range `9.3.4-canary.0 - 16.4.0`. The latest published version at audit time was `16.4.3`. The critical advisory set includes middleware/proxy bypass, SSRF, cache confusion, and RCE issues; this is a release blocker before public launch, especially because the app uses middleware and may add Server Actions. Upgrade to the patched line and re-audit in Phase 1.

### No test suite

There are no unit, integration, RLS, or browser tests. The current "verification" is lint plus a build that requires environment variables. Auth behavior has not been tested end-to-end against a real Supabase project.

---

## 5. Security and correctness findings

### 5.1 Critical: browser and server use different session stores

**Evidence**

- `src/lib/supabase-client.ts` imports `createClient` from `@supabase/supabase-js`. In a browser, that client defaults to `localStorage` for session persistence.
- `src/lib/supabase/server.ts`, `src/lib/supabase/middleware.ts`, and `src/app/auth/callback/route.ts` use `@supabase/ssr` cookie clients.
- `@supabase/ssr` documentation states that `createBrowserClient` always stores the session in cookies specifically so a server-rendered request can read it; using `@supabase/supabase-js` directly is the localStorage path.

**Impact**

- A user who signs in with email/password in a clean browser gets a localStorage session but no auth cookies. The subsequent hard redirect to `/dashboard` reaches a server component that sees no user and redirects back to `/login`.
- A user who arrives through the email-confirmation callback does get server cookies, so that path may appear to work.
- `LogoutButton` calls the localStorage client's `signOut()`. It clears the browser session but not the SSR cookies, so the server may still accept the access token until it expires.
- The NavBar can show "logged in" while the server shows "logged out", or vice versa.

**Required fix (Phase 1):** use `createBrowserClient` from `@supabase/ssr` for the browser singleton, and make logout a server-side operation that clears cookies. Verify signup → confirmation → login → dashboard → logout in a real browser with a real Supabase project.

### 5.2 Critical: vulnerable Next.js version

`next@16.2.10` is a direct dependency with a critical advisory. Upgrade to `next@16.4.3` or later in Phase 1, update React/types if required, and rerun `npm audit`, lint, build, and E2E tests. Do not use `npm audit fix --force` blindly.

### 5.3 High: production build is coupled to auth environment variables

`src/lib/supabase-client.ts` throws at module evaluation if `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` is missing. The landing page imports client components that import this module, so Next.js evaluates it while prerendering `/`. A clean checkout cannot build the marketing page without auth configuration.

**Required fix (Phase 1):** validate environment variables explicitly at startup/build with an actionable error; lazy-initialize the browser client inside effects/handlers; or otherwise decouple the public marketing page from server secrets. Document the required variables in `.env.example` and the README. The current `.gitignore` ignores `.env*`, so add an exception for `.env.example`.

### 5.4 High: no monitoring data plane or SSRF boundary

Monitoring arbitrary URLs is effectively a controlled SSRF engine. There is no checker, no egress policy, no private-IP blocking, no DNS-rebinding protection, and no worker isolation. This is not exploitable today because the feature does not exist, but it becomes the highest-risk part of the product the moment it is built. The design in §6 and Phase 4 is mandatory before accepting customer URLs.

### 5.5 High: waitlist abuse and weak constraints

The anonymous insert policy uses `WITH CHECK (true)`. There is no rate limit, CAPTCHA, email length limit, case-insensitive uniqueness, or source validation. An attacker can insert arbitrary volumes of rows with arbitrarily large `email`/`source` values. `created_at` and `source` are nullable, and uniqueness is case-sensitive (`Test@x.com` and `test@x.com` are different rows). The count function returns the current total, which is presented as the user's queue position; it is not their position.

Phase 1/2 should add database constraints, a case-insensitive unique index, length limits, a server-side submit path or CAPTCHA/rate limit, and honest queue-position wording. Harden the `SECURITY DEFINER` function with explicit grants and a safe `search_path`.

### 5.6 High: no tests or CI

There is no way to catch the auth regression above, RLS regressions, or a broken build in review. Phase 1 must add at least lint, type-check, unit tests, a production build, an audit gate, and an auth E2E test in CI.

### 5.7 Medium findings

| Finding | Impact / required action |
|---|---|
| `middleware.ts` is deprecated in Next.js 16 | Rename to `src/proxy.ts`, export `proxy`, keep Node runtime. Remove the build warning. |
| Auth errors are shown raw | Supabase messages can enumerate accounts or leak internals. Use generic public messages and log details server-side. |
| Password policy is 6 characters and client-only | Enforce a stronger policy server-side and configure the Supabase Auth project consistently. |
| Auth callback derives redirect origin from the request URL | Behind a proxy/host-header attack this can become an open redirect. Use a configured `NEXT_PUBLIC_SITE_URL`/allowlist and validate `next` paths. |
| No `next` return path | Users always land on `/dashboard` after login; acceptable for now, but add allowlisted return paths with auth hardening. |
| No security headers | Add CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and frame restrictions in Phase 1/7. |
| `getUser()` on nearly every request | Adds a network round trip to every page load. Keep authoritative checks close to data; consider `getClaims()`/scoped proxy once auth is fixed. |
| No rate limits | Auth, waitlist, monitor creation, test checks, and public status pages all need limits before launch. |
| No canonical site URL | Email redirects and callback URLs should not depend on `window.location.origin` in production. |
| Static marketing claims | The status pill, pricing tiers, multi-region, status pages, and protocol support are not backed by features. Fix copy or label as planned before launch. |

### 5.8 Low findings

- No `error.tsx`, `loading.tsx`, or custom `not-found.tsx`.
- Default Next.js SVGs remain unused in `public/`.
- Default favicon.
- README is generic create-next-app boilerplate.
- No `robots.ts`, `sitemap.ts`, or Open Graph image.
- No `engines` field in `package.json` despite Next.js requiring Node 20.9+.
- `npm ls` reports several extraneous `@emnapi/*` top-level packages after install; clean up the lockfile/tooling later.
- No `.env.example`, no local Supabase instructions, no deployment runbook.

---

## 6. Target architecture for real HTTP/HTTPS monitoring

### 6.1 Guiding principle: separate the control plane from the data plane

The Next.js app should manage users, configuration, dashboards, and status pages. It should **not** execute customer checks in request handlers or rely on serverless cron as the scheduler.

```text
                    ┌─────────────────────────────────────┐
                    │  Control plane (Next.js on Vercel)  │
                    │  auth, dashboard, monitor CRUD,     │
                    │  status pages, server actions/API   │
                    └───────────────┬─────────────────────┘
                                    │ Supabase client / server actions
                                    ▼
                    ┌─────────────────────────────────────┐
                    │  Supabase Postgres + Auth           │
                    │  RLS, monitors, results, incidents, │
                    │  alert outbox, status pages         │
                    └───────────────┬─────────────────────┘
                                    │ queue / leases / results
                                    ▼
                    ┌─────────────────────────────────────┐
                    │  Scheduler + queue (long-running)   │
                    │  due monitors, idempotency, jitter  │
                    └───────┬─────────────┬───────────────┘
                            │             │
                    ┌───────▼──────┐ ┌────▼─────────┐
                    │ Region A     │ │ Region B     │  ... (2+ regions)
                    │ HTTP checker │ │ HTTP checker │
                    └───────┬──────┘ └────┬─────────┘
                            │             │
                            └──────┬──────┘
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  Result ingestion + state machine   │
                    │  confirmation, incidents, outbox    │
                    └───────────────┬─────────────────────┘
                                    ▼
                    ┌─────────────────────────────────────┐
                    │  Alert dispatcher                   │
                    │  email, Discord, Telegram, webhook  │
                    └─────────────────────────────────────┘
```

### 6.2 Control plane

- Next.js App Router on Vercel (or a Node host) for auth, dashboard, monitor management, and public status pages.
- Supabase Auth for identity and Supabase Postgres for application data.
- Server Components/server actions/route handlers use a cookie-based Supabase server client.
- A data-access layer (DAL) performs `getUser()`/authorization and returns DTOs. Do not trust client-side auth state or proxy checks alone.
- The Supabase service-role key must never reach the browser. It belongs only in the worker/ingestion service or a trusted server runtime.
- Use `proxy.ts` only for optimistic redirects/session refresh; authoritative authorization stays in the DAL and database RLS.

### 6.3 Scheduler and queue

- Run a long-lived scheduler/worker process in a container platform (Fly.io, Railway, Render, AWS ECS, etc.), not inside Vercel request handlers.
- Use a durable queue or a Postgres-backed job table. Reasonable starting points: pg-boss/Graphile Worker on the existing Postgres, or BullMQ/Redis if throughput and multi-region routing justify the extra infrastructure.
- Per-region schedules or jobs: `monitor_id`, `region`, `scheduled_at`, `idempotency_key` with a unique constraint.
- Claim work with leases (`FOR UPDATE SKIP LOCKED` or queue visibility timeouts) and support graceful shutdown.
- Add jitter to avoid a thundering herd at interval boundaries.
- At-least-once delivery is fine if result writes are idempotent.
- Track scheduler lag, queue depth, worker heartbeat, and failed/dead-letter jobs.

A serverless cron alone is not sufficient: granularity and duration limits vary by plan, cold starts add jitter, there is no long-lived scheduler, egress is less controllable, and multi-region execution is awkward. Serverless can host the control plane; the check engine should be a dedicated worker.

### 6.4 HTTP/HTTPS checker requirements

Start with HTTP/HTTPS only. Do not claim ping, TCP port, cron, or SMS support until those systems exist.

**Request configuration**

- URL, method (`GET`, `HEAD`, and later `POST`/`PUT`/`PATCH`/`DELETE`), custom headers, body, expected status codes or ranges, optional body keyword/regex.
- Timeouts: connect timeout, total request timeout, and response-body read timeout. The timeout must be shorter than the check interval.
- Redirect policy: manual hops, maximum hop count, revalidate the destination at every hop, never auto-follow.
- Max response-body size; do not store response bodies.
- TLS verification on by default; record certificate expiry. Any "ignore TLS errors" option must be explicit and visibly risky.
- User-Agent identifying OneDash; no secrets in URLs; secrets in headers encrypted at rest.
- Response time breakdown: DNS, connect, TLS, time-to-first-byte, total.

**Failure classification**

- DNS failure, connection refused, timeout, TLS error, HTTP status mismatch, body assertion failure, redirect loop, blocked target, and internal checker error should be distinct error classes.
- Record sanitized error details, region, attempt, and timings.
- Never log authorization headers, cookies, request bodies containing secrets, or full response bodies.

### 6.5 SSRF and abuse protection (non-negotiable)

A monitoring product accepts arbitrary destinations, so the checker must be treated as an untrusted network boundary.

- Resolve DNS and reject private, loopback, link-local, multicast, unspecified, and reserved ranges for IPv4 and IPv6 (including `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`).
- Block cloud metadata endpoints, especially `169.254.169.254` and IPv6 equivalents.
- Pin/validate the resolved IP for the actual connection to prevent DNS rebinding; re-resolve and revalidate every redirect.
- Allow only `http`/`https` and ports 80/443 by default. Any custom-port support needs an explicit allowlist and plan gating.
- Reject credentials embedded in URLs, malformed hosts, decimal/hex/octal IP encodings, and userinfo tricks.
- Cap response size and enforce timeouts.
- Put workers in an egress-isolated network/subnet with firewall rules that cannot reach the control plane, Supabase private network, or cloud metadata service. Use an outbound proxy if the platform cannot enforce this.
- Apply the same SSRF protections to user-configured webhook destinations.
- Add per-account monitor limits, test-check rate limits, and abuse review before enabling arbitrary URLs.

### 6.6 Result storage, state machine, and alerting

- `check_results` is append-heavy. Partition by time, index by `(monitor_id, checked_at desc)`, and plan retention/rollups from day one.
- `monitor_state` holds current status, consecutive failures/successes, last check, last status change, and open incident.
- Confirmation policy: do not open an incident on one transient failure. Use consecutive failures, multi-region quorum, or both. Make it configurable per plan later.
- Incident transitions are transactional. Only one open incident per monitor. Recovery closes the incident and emits a recovery event.
- Alerting uses a transactional outbox: state change writes an `alert_deliveries` row in the same transaction; a dispatcher sends it with retries and exponential backoff.
- Deduplicate per incident/channel; apply cooldowns and maintenance windows.
- Start with email plus one chat/webhook channel. Add Discord/Telegram/SMS only when delivery logs and retries are solid.
- Encrypt channel secrets at rest; never return them to the browser.

### 6.7 Data model (target)

| Table | Purpose |
|---|---|
| `profiles` | App-level user profile keyed to `auth.users(id)`. |
| `organizations` | Tenant boundary. |
| `organization_members` | User/org membership with role (`owner`, `admin`, `member`, `viewer`). |
| `monitors` | URL, method, headers (encrypted), expected status/body, interval, timeout, regions, active flag, plan limits. |
| `monitor_schedules` | Optional per-region due timestamps/leases for scheduling. |
| `monitor_state` | Current status, failure counters, last check, open incident. |
| `check_results` | Append-only results, timings, error class, region, idempotency key; partitioned. |
| `incidents` | Confirmed outages and recoveries. |
| `incident_updates` | Human/system timeline entries. |
| `alert_channels` | Email/webhook/Discord/Telegram configuration, encrypted secrets. |
| `monitor_alert_channels` | Which channels receive which monitor's alerts. |
| `alert_deliveries` | Outbox, attempts, next attempt, status, response metadata. |
| `status_pages` | Public slug/name/branding/published flag. |
| `status_page_monitors` | Which monitors appear on a page. |
| `audit_logs` | Sensitive configuration changes. |
| `usage_counters` | Plan enforcement (optional initially). |

Use UUIDs, `timestamptz`, enums or checked text, `NOT NULL` where appropriate, foreign keys with deliberate delete behavior, and partial/unique indexes for active schedules and open incidents.

### 6.8 RLS and database roles

- Enable RLS on every tenant table. No exceptions for convenience.
- Use a `SECURITY DEFINER` helper such as `is_org_member(org_id)` with a fixed `search_path` to avoid recursive policies.
- Policies: users can access rows only for organizations they belong to; owners/admins can manage sensitive configuration; viewers are read-only.
- Anonymous users may read only explicitly published status-page data through a narrow view/RPC, never `monitors`, `check_results`, `alert_channels`, or secrets.
- The worker uses a dedicated least-privilege role or service role only for ingestion/state transitions. It must not expose that key to Next.js client bundles.
- Write RLS tests for anon, authenticated same-org, authenticated other-org, owner/admin/member/viewer, and worker roles.

### 6.9 Deployment topology

| Component | Recommended deployment |
|---|---|
| Next.js control plane | Vercel or a Node container |
| Supabase Auth/Postgres | Supabase managed project; separate dev/staging/prod |
| Scheduler/checker | Dedicated container service, at least two regions |
| Queue | Postgres-backed initially; Redis if scale requires it |
| Alert dispatcher | Same worker service or a separate worker |
| Observability | Sentry/OpenTelemetry + hosted metrics/logs |
| Backups | Supabase PITR/backups plus tested restore procedure |

Supabase connection pooling is required if many workers connect directly. Keep the worker's DB connections bounded; do not open a connection per check.

---

## 7. Implementation phases

Phases 1–7 are the first-release path. Phase 8 is post-launch expansion. Phase 3 and Phase 4 can overlap, but neither is complete until both are done. Do not enable customer monitoring before Phase 1 auth and Phase 4 SSRF controls are complete.

### Phase 0 — Audit (complete)

**Goal:** establish an honest baseline without changing behavior.

- [x] Read `AGENTS.md`, `package.json`, Next.js/Supabase setup, auth routes/components, dashboard, landing page, and `supabase/schema.sql`.
- [x] Inventory all non-generated files.
- [x] Record that the supplied folder has no git repository or history.
- [x] Run lint and production build commands.
- [x] Identify implemented features, scaffolds, placeholders, and missing systems.
- [x] Review auth, database security, and monitoring architecture.
- [x] Create this roadmap.
- [x] Do not edit functional source, SQL schema, dependencies, or deployment settings.

**Exit criteria:** audit report and roadmap published; no functional changes.

---

### Phase 1 — Auth correctness and baseline hardening

**Goal:** make the existing auth flow genuinely work end-to-end and remove release-blocking security/config debt before adding monitoring.

**Work**

1. Establish version control (or import the intended history) and commit the audited baseline. Add a short project README with setup and architecture.
2. Upgrade Next.js to `>=16.4.3` (or the latest patched 16.x), update compatible React/types, and re-run the full verification matrix.
3. Rename `src/middleware.ts` to `src/proxy.ts`, export `proxy`, keep the Node runtime, and remove the deprecation warning.
4. Replace the `@supabase/supabase-js` browser singleton with `createBrowserClient` from `@supabase/ssr`; keep one browser client and one server client. Remove localStorage-based auth state.
5. Make logout a server-side operation that clears Supabase SSR cookies. Verify the NavBar, dashboard, and login/signup redirects all agree.
6. Add environment validation and `.env.example`; document Supabase URL, anon key, site URL, and local setup. Add a `.gitignore` exception for `.env.example`.
7. Decouple the public landing page from auth env at module evaluation, or make the missing-env failure a single actionable build error instead of a prerender stack. Ensure CI supplies safe placeholder public values for builds.
8. Add a canonical site URL and allowlist for email redirects and auth callback `next` paths. Reject untrusted host-derived origins.
9. Harden auth UX/security: generic public error messages, server-enforced password policy, email-confirmation configuration documented, rate limits on login/signup/waitlist, and bot protection (e.g., Turnstile/CAPTCHA) if public signup is enabled.
10. Add security headers (`CSP`, HSTS in production, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame restrictions) and disable the unnecessary `X-Powered-By` header.
11. Harden the waitlist: length/format/case-insensitive constraints, source allowlist, `created_at NOT NULL`, rate limit/CAPTCHA, honest queue-position text, and explicit function grants.
12. Add the test stack: Vitest (or equivalent) for units, Playwright for auth E2E, and an RLS test harness when Phase 2 lands. Add CI for install, lint, type-check, unit tests, build, and `npm audit --omit=dev`.
13. Align version labels and remove or label the static marketing claims that are not implemented.

**Acceptance criteria**

- [x] In a clean browser against the local Supabase project: signup → confirmation email → callback → dashboard → logout all work. Verified manually on 2026-10-28 (see the verification snapshot).
- [x] Password login creates server-readable cookies; no Supabase auth key is stored in `localStorage`. Verified in the browser: auth cookies were present while signed in and `localStorage` was empty.
- [x] Logout clears cookies and redirects to a logged-out page; a revisit of `/dashboard` redirects to `/login`. Verified in the browser.
- [x] Logged-out `/dashboard` redirects to `/login`; logged-in `/login` and `/signup` redirect to `/dashboard`. Verified in the browser.
- [x] NavBar, server components, proxy, and logout agree on auth state. Verified in the browser while signed in, after refresh, and after logout.
- [ ] **PARTIAL.** `npm run lint`, unit tests, and `npm run build` pass in CI, and the manual browser E2E passed; an automated Playwright auth E2E suite is still not implemented, so the CI criterion is not fully met.
- [x] `npm audit --omit=dev` reports 0 vulnerabilities (2026-10-28).
- [x] The `middleware` deprecation warning is gone; the build output shows `ƒ Proxy (Middleware)` with no warning.
- [x] Missing env values produce one clear, actionable error, not a prerender stack. Covered by unit tests; the landing page builds without Supabase env.
- [x] Security headers are present on HTML responses. Verified with `npm start` plus an HTTP request (see the verification snapshot).
- [x] No service-role key or other server secret is present in the client bundle. No `SUPABASE_SERVICE_ROLE_KEY` or `service_role` references were found in `.next/static`.
- [x] README explains local Supabase, env vars, migrations, and verification commands.

**Exit gate: met for manual verification.** The cookie-based auth flow is usable and was verified in a browser. Automated Playwright E2E remains open, so the CI acceptance criterion is only partially met.

**Known Phase 1 gaps (not changed by Phase 2):** Playwright auth E2E was not added; the landing page still contains the hard-coded "All systems operational" pill and unbuilt ping/TCP/cron, multi-region, and status-page claims; version labels remain `v0.1`. These are tracked by Phase 1 work items 12–13 and Phase 7.

---

### Phase 2 — Database foundation, migrations, and tenant isolation

**Goal:** replace the single manual schema file with a versioned, tested, tenant-safe data model.

**Work**

- Adopt Supabase CLI migrations (`supabase/migrations/*.sql`), a local Supabase stack, seed data, and an ERD. Treat `supabase/schema.sql` as legacy and remove or regenerate it after migration parity is proven.
- Add `profiles`, `organizations`, `organization_members`, and role helpers.
- Add `monitors`, `monitor_schedules`, `monitor_state`, `check_results`, `incidents`, `incident_updates`, `alert_channels`, `monitor_alert_channels`, `alert_deliveries`, `status_pages`, `status_page_monitors`, and `audit_logs`.
- Define enums/checks, foreign keys, delete behavior, timestamps, and indexes. Use a unique idempotency key for check results and a partial unique index for one open incident per monitor.
- Partition or plan partitioning for `check_results`; define raw retention and rollup tables (1-minute, 1-hour, 1-day).
- Enable RLS everywhere. Add `is_org_member`/role helpers with fixed `search_path`. Write policies for owner/admin/member/viewer, with public status pages limited to published read-only data.
- Create separate database roles for the worker/ingestor and the app; document least-privilege grants.
- Migrate and harden the waitlist constraints and function grants.
- Write RLS tests covering anon, same-org, other-org, each role, worker ingestion, and public status-page access.

**Acceptance criteria**

- [x] `supabase db reset` applies every migration from an empty database without manual SQL. Verified: 5 migrations + seed.
- [x] Seed data and a documented local setup work on a fresh clone. Verified locally; CI runs reset and the database suite.
- [x] Every tenant table has RLS enabled and a test proving cross-tenant access is denied. 150 pgTAP assertions pass.
- [x] Anonymous users cannot read monitors, checks, incidents, alert channels, deliveries, or secrets.
- [x] A published status page exposes only its published monitors and public fields; private monitors do not leak.
- [x] An owner/admin can manage organization resources; a viewer cannot mutate them.
- [x] Check-result idempotency is enforced by a unique constraint.
- [x] Only one open incident per monitor is possible.
- [x] Active-monitor schedule queries have supporting indexes.
- [ ] **DEVIATION — not met as written.** The worker role can ingest results and update state, and cannot manage users, but it can read monitoring/alerting rows for all tenants. This is intentional for a global scheduler and is documented in `docs/database.md`; it needs explicit approval or a per-tenant worker redesign before Phase 4.
- [ ] **PARTIAL.** Waitlist rows reject oversized/invalid emails and duplicate case variants (verified by pgTAP), and anonymous direct inserts are closed. Rate limiting remains in-process and per instance, not shared or WAF-backed, so abuse protection is not fully met.
- [ ] **PARTIAL.** Backup/retention expectations and a partition/rollup plan are documented, but `check_results` is not partitioned, no rollups exist, and the raw-retention window is still an open product decision.

**Exit gate:** met for schema reproducibility and tested cross-tenant isolation. The worker-role deviation, per-instance waitlist limiter, and unimplemented partitioning/rollups are explicitly open and must be resolved or accepted before Phase 4.

**Phase 2 delivered:** five versioned migrations, a two-organization seed, 150 passing pgTAP assertions, `docs/database.md` (ERD, role matrix, RLS helpers, worker role, retention plan), a database CI job, and Supabase CLI scripts.

**Phase 2 deferred:** `check_results` partitioning and rollups, a shared waitlist limiter, per-tenant worker isolation, remote Supabase deployment, monitor CRUD UI, and the scheduler/checker (Phase 3/4).

---

### Phase 3 — Monitor management (control plane)

**Goal:** let an authenticated user create, inspect, pause, edit, and delete HTTP/HTTPS monitors without exposing them to other tenants.

**Delivered (2026-10-28, `phase-3/monitor-management`)**

- Server Actions for create, update, pause/resume, and delete, with server-side
  auth, trusted membership/org resolution, role checks, custom validation, and
  safe DTOs/errors. Zod was not added; validation lives in
  `src/lib/monitor-validation.ts` and is covered by Vitest.
- `/dashboard` list/count, `/dashboard/monitors/new`, monitor detail, and edit
  pages, with empty/loading/error/success states, responsive layout, labels,
  focusable delete confirmation, pending/disabled controls, and a global
  "monitoring execution is not active" notice.
- First-release fields: name, HTTP/HTTPS URL, `GET`/`HEAD`, expected status
  code/list/range (max 20 codes), interval (default 5 minutes), timeout,
  active/paused, and timestamps.
- URL validation rejects non-HTTP schemes, malformed URLs, embedded
  credentials, unsupported ports, and obvious localhost/private/link-local/
  metadata targets. This is configuration-time hardening, not the Phase 4 SSRF
  boundary.
- A database-enforced development limit (default 25 monitors per organization)
  using a protected singleton settings table, a `SECURITY DEFINER` read
  function, and a `BEFORE INSERT` trigger with a per-organization advisory
  lock. Authenticated users cannot read or raise the setting. No billing or
  plan entitlement system was added.
- Explicit-column repository selects keep scheduler fields, encrypted request
  secrets, ciphertext, and worker credentials out of application DTOs.
- Existing Phase 2 audit triggers record monitor insert/update/delete events.
- pgTAP coverage for anon denial, same-org access, cross-org denial, viewer
  denial, creator/org forgery, the limit, privileged bypass attempts, and the
  advisory lock; Vitest coverage for validation, service authorization, server
  actions, the form, list, and delete/toggle controls.

**Deferred by scope**

- Headers, request bodies, regions, alert-channel selection, and a "Test check"
  action are not part of this release. There is no outbound request from the
  Next.js process. Header/body limits and test-check results move to Phase 4/5
  when those fields and the checker exist.
- Full SSRF protection (DNS resolution, address pinning, redirect-hop
  revalidation, egress isolation) is Phase 4.
- No plan/billing enforcement; the 25-monitor limit is a documented development
  guard.
- The list is capped at 200 rows with no pagination.

**Acceptance criteria**

- [x] A user can create an HTTP and an HTTPS monitor, see it in the list, edit
  it, pause/resume it, and delete it. Covered by service/action/component tests
  and pgTAP; a manual browser pass was not repeated in this verification pass.
- [x] Invalid schemes, malformed URLs, unsupported methods, credentials in
  URLs, and out-of-range intervals/statuses are rejected with clear errors.
- [x] A URL pointing at localhost/private space is rejected at configuration
  time with a clear reason. Full DNS/redirect SSRF enforcement remains Phase 4.
- [ ] **DEFERRED BY DESIGN.** Test check is not implemented; Phase 3 performs
  no outbound customer fetch.
- [x] A user from another organization cannot read, update, pause, or delete the
  monitor; the app returns 404/not-found and RLS denies the row.
- [x] Viewers cannot mutate monitors (UI, service, and RLS tests).
- [x] The development limit is enforced by the server and database and tested,
  including direct privileged inserts and the advisory-lock path. Plan limits
  are not implemented.
- [x] The UI has empty, loading, error, and success states and is keyboard
  operable; component tests cover labels, focus, Escape, pending controls, and
  error announcements. No formal WCAG audit was run.
- [x] No monitor status, latency, uptime, or check history is synthesized. The
  UI shows a timestamp only when stored `monitor_state` data exists; new
  monitors show "No checks recorded." Seed data is explicitly development data.

**Exit gate: met for the control plane, with the deferred items above.** Monitor
configuration is tenant-safe and ready for the Phase 4 worker to consume; it is
not being executed yet.

---

### Phase 4 — Scheduler, worker, and HTTP/HTTPS checker (data plane)

**Goal:** execute checks reliably from isolated workers and persist trustworthy results.

**Phase 4A status (2026-11-01): Phase 4A.1 hardening delivered on
`phase-4a/safe-http-checker`.** The standalone module in `worker/checker/` is
independently tested and not imported by Next.js. It is not connected to a
scheduler, database, or customer monitor.

Phase 4A delivered:

- A bounded checker contract for `GET`/`HEAD`, expected statuses, timeout,
  required TLS verification, and optional redirect following.
- URL, scheme, credential, port, hostname, and redirect validation.
- DNS resolution with every-answer validation, mixed public/private rejection,
  and one-address pinning.
- A pinned Undici connector that preserves the Host header, TLS SNI, and
  certificate-verification name; TLS verification stays enabled and no second
  unchecked DNS lookup is performed.
- Manual redirect revalidation, loop detection, and a five-hop cap.
- Total deadline, DNS/connect/header/body timeouts, response-size cap, redirect
  cap, concurrency cap, and cleanup on success, failure, timeout, or
  cancellation.
- Sanitized results with fixed messages and no URL, hostname, query, headers,
  body, cookies, or secrets.
- Injected DNS/transport tests, local loopback HTTP/HTTPS tests, and pgTAP
  coverage for the tightened monitor/result contract.
- `ROADMAP.md`, `README.md`, `docs/database.md`, and `worker/README.md`
  documentation, including the egress-isolation release blocker.

Phase 4A.1 delivered (2026-11-01):

- An HTTPS monitor may redirect to HTTPS but not downgrade to plaintext HTTP.
  HTTP-to-HTTPS upgrades and HTTPS-to-HTTPS redirects remain allowed. The rule
  is applied to every hop and has no monitor or environment opt-out.
- Bounded address fallback: up to three validated addresses per hostname per
  hop. Every DNS answer is validated before use. Only pre-response connection
  refused/failure or timeout is retried; TLS errors and returned HTTP statuses
  are never retried. The total deadline is unchanged, and each attempt preserves
  the hostname for the Host header, TLS SNI, and certificate verification.
- Local TLS coverage with runtime-generated disposable certificates: a trusted
  test CA, wrong-hostname rejection, self-signed rejection, SNI/Host
  preservation, IPv6 loopback where available, and a real `checkMonitor` +
  Undici + local TLS server path. Unsupported environments skip explicitly
  rather than reporting a false pass.
- A new migration persists `redirect_count` and `response_bytes`, with
  non-negative constraints and pgTAP coverage for defaults, rejection of
  negative values, and tenant isolation.
- A read-only `supabase/preflight/phase_4a_monitor_compatibility.sql` check for
  legacy monitor rows that would block the Phase 4A constraints. It reports
  rows and rolls back; it never deletes, disables, or rewrites monitors.
- The committed test private key and certificate were removed. Test certificates
  are generated at runtime. The old key remains in git history at the Phase 4A
  commit; history was not rewritten, and secret scanners that inspect history
  may still flag that disposable test key.
- Documentation updated for fallback, downgrade, metrics, preflight, and the
  remaining TLS/IPv6/deployment limits.

Deferred to Phase 4B/4C:

- Dockerized worker service, bounded DB connections, graceful shutdown, and
  heartbeat.
- Scheduler queueing, per-region jobs, idempotency keys, leases, jitter,
  retries, dead-letter handling, and result persistence.
- Request headers/bodies/secrets, body assertions, certificate-expiry capture,
  and latency-threshold evaluation.
- Two or more regions, confirmation/quorum policy, worker metrics, load tests,
  and runbook.
- Deployment-level egress isolation. Application validation is not sufficient;
  the worker host/network must deny private, link-local, loopback, metadata,
  control-plane, and Supabase private-network egress. If the hosting environment
  cannot enforce this, customer checks remain blocked.

**Work remaining for the full phase**

- Create a standalone worker service (TypeScript/Node, Dockerized) with bounded DB connections and graceful shutdown.
- Implement scheduler queueing with per-region jobs, unique idempotency keys, leases, jitter, retries, dead-letter handling, and heartbeat.
- Extend the Phase 4A checker with the deferred request configuration and result persistence.
- Enforce egress isolation in the worker deployment.
- Persist results with region, attempt, timings, status, and sanitized error class. Make writes idempotent.
- Add at least two regions and a configurable confirmation/quorum policy.
- Add worker metrics: checks attempted/succeeded/failed, duration, scheduler lag, queue depth, heartbeat, and dead-letter count.
- Add capacity/load tests and a worker runbook.

**Acceptance criteria**

- [ ] A monitor configured at a 5-minute interval is checked close to schedule; scheduler lag p95 is measured and within the agreed target (proposed: ≤15 seconds).
- [ ] Duplicate jobs for the same monitor/region/scheduled time produce one idempotent result.
- [ ] Killing a worker mid-check loses no acknowledged job; leases expire and work is retried.
- [x] **Phase 4A:** timeout, connection refused, DNS failure, TLS failure, status mismatch, redirect loop, blocked target, response too large, unsupported configuration, and internal error produce distinct, sanitized results.
- [ ] Body-mismatch results are implemented. Phase 4A rejects body assertions as `unsupported_configuration` instead of silently ignoring them.
- [x] **Phase 4A:** redirects are validated at every hop and cannot reach a private/metadata address.
- [x] **Phase 4A.1:** an HTTPS monitor cannot be redirected to plaintext HTTP; HTTP-to-HTTPS and HTTPS-to-HTTPS redirects remain allowed, and there is no opt-out.
- [x] **Phase 4A.1:** a hostname with multiple validated addresses tries at most three, only after a pre-response connection failure/timeout, within the unchanged total deadline; TLS errors and HTTP responses are not retried.
- [x] **Phase 4A.1:** local trusted-CA, wrong-hostname, self-signed, SNI/Host, and real checker/Undici TLS tests pass where the environment supports them; unsupported cases skip explicitly.
- [x] **Phase 4A.1:** `redirect_count` and `response_bytes` are persisted by a new migration, constrained to non-negative values, and covered by tenant-isolation pgTAP tests.
- [x] **Phase 4A.1:** a read-only preflight reports legacy monitors that would block the Phase 4A constraints without deleting, disabling, or rewriting them.
- [x] **Phase 4A:** the application-level SSRF suite blocks localhost, RFC1918, link-local, IPv6 equivalents, metadata IPs, decimal/hex IP forms, IPv4-compatible/mapped forms, DNS rebinding, and redirect-to-private cases.
- [ ] **Deployment gate:** the worker host/network enforces egress isolation for private, link-local, loopback, metadata, control-plane, and Supabase private networks. This is a release blocker, not an application-only claim.
- [x] **Phase 4A:** only ports 80/443 are allowed by default; the checker has no exception path.
- [x] **Phase 4A:** response bodies are not stored; checker results contain no URL, hostname, query, headers, body, cookies, or secrets.
- [ ] At least two regions return tagged results; the confirmation policy is documented and testable.
- [ ] A load test for the agreed initial capacity (for example, 1,000 monitors at a 5-minute interval) meets the lag/duration targets.
- [ ] Worker heartbeat, scheduler lag, queue depth, and failure metrics are visible.
- [x] **Phase 4A:** the checker does not run inside Vercel request handlers or rely on serverless cron as its only scheduler.

**Exit gate:** checks are reliable, isolated, and safe enough to enable for internal test monitors. Phase 4A clears the checker-foundation portion only; the scheduler, persistence, regions, metrics, and deployment egress gate remain unmet, so the full exit gate is not cleared.

---

### Phase 5 — Incidents and alerting

**Goal:** turn raw check results into a small number of trustworthy incidents and notifications.

**Work**

- Implement the monitor state machine: up/degraded/down, consecutive failures/successes, multi-region quorum, recovery, maintenance windows, and flapping suppression.
- Open one incident per confirmed outage; add an incident timeline and automatic resolution.
- Add a transactional alert outbox and a dispatcher with retries, exponential backoff, deduplication, cooldowns, and delivery logs.
- Start with email; add one chat/webhook channel. Add Discord/Telegram/SMS only after the outbox is proven.
- Add channel configuration, verification/test alerts, and encrypted secret storage.
- Add HMAC-signed webhooks with timestamps and replay protection; apply SSRF protection to webhook destinations.
- Enforce role permissions for channel management and expose delivery status in the UI.

**Acceptance criteria**

- [ ] A simulated outage produces exactly one incident and one alert per configured channel, not one per failed check.
- [ ] A single transient failure does not open an incident when the confirmation policy requires multiple failures/regions.
- [ ] Recovery resolves the incident and sends a recovery notification.
- [ ] Flapping does not spam alerts; cooldown/dedupe behavior is tested.
- [ ] Failed deliveries are retried with backoff and end in a visible dead-letter/failed state.
- [ ] A user can send a test alert from the UI; the delivery log records the result.
- [ ] Channel secrets are encrypted at rest and never returned to the browser.
- [ ] Another organization cannot read or modify channels or delivery logs.
- [ ] Detection-to-first-alert p95 is measured and within the agreed target (proposed: ≤90 seconds with two regions).
- [ ] Webhook signatures/replay protection and webhook SSRF tests pass.

**Exit gate:** incidents are credible and alerts are operationally safe.

---

### Phase 6 — Dashboard analytics and public status pages

**Goal:** make monitoring visible to users and shareable with their customers without leaking data.

**Work**

- Add uptime %, p50/p95 latency, status history, and incident timeline backed by rollups.
- Add time-range controls, recent checks, monitor detail charts, and per-region views where useful.
- Build public status pages with a slug, published monitor selection, current status, 90-day uptime, and incident history.
- Add caching/revalidation, `noindex` options, and a clear unpublished/private state.
- Defer custom domains and branding until the core page is reliable and secure.
- Add accessible charts/tables and responsive layouts.

**Acceptance criteria**

- [ ] Dashboard numbers reconcile with raw results/rollups for a seeded dataset within an agreed tolerance.
- [ ] A logged-out visitor can load a published status page; unpublished/private monitors are absent.
- [ ] The status page exposes no emails, secrets, headers, internal IDs, or unpublished monitor names.
- [ ] Status-page updates appear within 60 seconds of a check/incident change.
- [ ] Uptime calculations handle missing checks and maintenance windows explicitly.
- [ ] Charts have accessible text/table alternatives and pass basic accessibility checks.
- [ ] Cross-tenant and anon access tests pass.
- [ ] Custom domains remain explicitly out of scope for this phase.

**Exit gate:** users can see and share accurate monitoring data safely.

---

### Phase 7 — Production readiness and launch

**Goal:** operate OneDash as a reliable, supportable service.

**Work**

- Define SLOs and dashboards: control-plane availability, scheduler lag, check success rate by region, detection latency, alert delivery, and data freshness.
- Monitor OneDash itself (dogfooding) and add on-call/alerting for worker failure, scheduler lag, queue depth, DB saturation, and alert-delivery failure.
- Add rate limits and abuse controls at auth, waitlist, monitor creation, test checks, and public pages; add plan enforcement/suspension.
- Configure backups/PITR, retention jobs, partition maintenance, and run a restore drill.
- Complete security work: threat model, dependency audit, CSP/headers verification, secret scanning, webhook signing, SSRF review, and an external review/pen test before public launch if possible.
- Add legal pages and real footer links: Terms, Privacy, acceptable use, DPA/cookie policy as applicable.
- Add billing only if paid plans are actually launched; otherwise label pricing as planned/waitlist and do not imply paid features are available.
- Reconcile marketing with reality: replace the hard-coded "All systems operational" pill, label unbuilt features, and remove or defer claims for ping/TCP/cron, multi-region, status pages, and team features until they ship.
- Add `error.tsx`, `loading.tsx`, `not-found.tsx`, `robots.ts`, `sitemap.ts`, metadata/OG assets, and performance/accessibility passes.
- Write deployment, rollback, incident-response, and support runbooks. Use separate dev/staging/prod Supabase projects and canary the worker.

**Acceptance criteria**

- [ ] SLO dashboards and alerts exist; OneDash monitors itself and a test page.
- [ ] A restore-from-backup drill succeeds within the agreed RTO; RPO is documented.
- [ ] Rate limits and abuse controls are tested; plan limits cannot be bypassed via the API.
- [ ] No critical or high security findings remain in the production dependency/runtime surface; any accepted risk is documented.
- [ ] Security headers and CSP are verified in production.
- [ ] Legal pages are reachable from the footer and cover monitoring/acceptable use.
- [ ] Every public marketing claim is implemented or clearly labeled as planned; no fake live status/metrics.
- [ ] Error/loading/not-found pages exist; basic accessibility and Lighthouse targets pass.
- [ ] Worker canary, rollback, and on-call runbooks are rehearsed.
- [ ] Launch checklist is signed off.

**Exit gate:** public launch.

---

### Phase 8 — Post-launch expansion (optional, demand-driven)

Do not start these until HTTP/HTTPS monitoring, incidents, alerts, and status pages are reliable.

- ICMP ping, TCP/port checks, DNS checks, cron/heartbeat (push) monitoring.
- SMS, Microsoft Teams, Slack, PagerDuty, and additional alert channels.
- Teams/roles expansion, audit-log UI, SSO, and API keys.
- Custom status-page domains and branding.
- Additional regions, advanced confirmation policies, and enterprise retention.
- Self-hosting docs/container images if "open-source core" remains a claim.
- Usage-based billing and annual plans.

Each item needs its own design/security review, acceptance criteria, and marketing update. Do not advertise a protocol or channel before it is generally available.

---

## 8. Cross-cutting definition of done

Every phase must satisfy these unless an explicit exception is documented:

- **Authorization:** every mutation checks authentication and organization membership server-side; client-side hiding is never sufficient.
- **RLS:** every tenant table has RLS enabled and tests for anon/same-org/other-org/role access.
- **Secrets:** service-role keys, monitor headers, and alert credentials never reach the browser or logs.
- **Outbound safety:** every customer-controlled URL or webhook passes the SSRF policy; no direct fetches from the Next.js web tier.
- **Idempotency:** retries and duplicate jobs cannot create duplicate results, incidents, or alerts.
- **Observability:** new background work has metrics, structured logs, and failure visibility.
- **Tests:** unit tests for logic, integration tests for DB/RLS, E2E for user flows.
- **Migrations:** schema changes are versioned and reproducible from empty.
- **Documentation:** setup, env vars, runbooks, and architecture notes are updated.
- **Quality gate:** lint, type-check, tests, build, and audit pass in CI; no new critical/high runtime vulnerabilities.
- **Rollback:** the change can be disabled or reverted without data loss.
- **Accessibility:** user-facing forms and charts have labels, keyboard access, and text alternatives.

---

## 9. Proposed service targets

These are targets to validate in Phase 4/7, not current behavior.

| Metric | Proposed target |
|---|---|
| Scheduler lag | p95 ≤15 seconds |
| Check execution | p95 ≤5 seconds for healthy endpoints; hard timeout ≤10 seconds |
| Detection to first alert | p95 ≤90 seconds with two regions and confirmation |
| Alert delivery | p95 ≤60 seconds after incident confirmation |
| Dashboard data freshness | ≤60 seconds |
| Control-plane availability | 99.9% monthly |
| Public status-page availability | 99.95% monthly |
| Worker heartbeat | every 30 seconds; alert after two missed heartbeats |
| False-alarm rate | <1% of confirmed incidents, measured manually |
| Backup RPO / RTO | RPO ≤5 minutes with PITR; RTO ≤1 hour, tested |
| Data retention | Raw checks 30–90 days; rollups retained longer (decide in Phase 2) |

---

## 10. Risks and open decisions

### Risks

1. **SSRF/abuse is existential.** A monitor that can reach internal networks or cloud metadata can compromise the platform. No launch without egress isolation, DNS pinning, and a tested SSRF suite.
2. **Serverless scheduling is the wrong tool.** A Vercel-only design will produce unreliable intervals and poor multi-region behavior.
3. **Auth regression risk.** The current browser/server split must be fixed and covered by E2E tests before any data features are added.
4. **Database growth.** Check results can overwhelm Postgres without partitioning, retention, and rollups.
5. **Alert fatigue.** Incorrect confirmation/dedupe will make the product untrustworthy. Flapping and recovery must be tested.
6. **Email deliverability.** Alert email needs SPF/DKIM/DMARC, bounce handling, and a reputable provider.
7. **Multi-region cost and complexity.** Quorum checks multiply requests and infrastructure; decide the minimum viable region set.
8. **Marketing/legal exposure.** Claims for unimplemented features and monitoring third-party sites require clear terms and acceptable-use language.
9. **No git history.** The supplied snapshot has no version control; work can be lost and no diff/baseline can be audited until a repository is established.
10. **Dependency debt.** The critical Next.js advisory and several transitive high advisories must be resolved before launch.

### Open decisions

- Worker host and initial regions (Fly.io, Railway, Render, AWS, etc.).
- Queue choice: Postgres-backed (pg-boss/Graphile Worker) vs Redis/BullMQ.
- Free-plan limits: monitors, minimum interval, retention, alert channels.
- Confirmation policy: consecutive failures, multi-region quorum, or both; default for free vs paid.
- Whether email/password remains the only auth method at launch; MFA/password reset timing.
- Public status-page URL scheme (path vs subdomain) and custom-domain timing.
- Launch alert channels (email + which chat/webhook channel).
- Raw-result retention and rollup granularity.
- Whether to keep the waitlist separate from product accounts or migrate waitlist users into onboarding.
- Billing provider and whether paid plans launch with the first release.
- Supported ports beyond 80/443 and whether customers may monitor private endpoints via an agent (not planned initially).
- Data residency/GDPR requirements and Supabase region choice.

---

## 11. Phase 0 files changed

| File | Change |
|---|---|
| `ROADMAP.md` | **Created.** Audit baseline, target architecture, phases, and acceptance criteria. |

No functional source code, SQL schema, package dependency, lockfile, or deployment configuration was edited. `npm ci` created `node_modules/`; `npm run build` created `.next/` and `next-env.d.ts`. These are ignored generated artifacts, not source changes. `package-lock.json` and source file timestamps were unchanged by the audit.

Because the supplied folder is not a git repository, there is no `git status`, tracked-file list, or diff to attach. Establishing version control is a Phase 1 prerequisite.
