# OneDash

OneDash is an early-stage uptime-monitoring product. The current release is a
Next.js marketing site with a Supabase-backed waitlist and a working
email/password authentication flow. Monitor CRUD, scheduled checks, incidents,
alerts, and public status pages are not implemented yet; see
[`ROADMAP.md`](./ROADMAP.md).

## Stack

- Next.js 16 (App Router, Turbopack, `proxy.ts`)
- React 19
- TypeScript
- Tailwind CSS 4
- Supabase Auth + Postgres (`@supabase/ssr` cookie sessions)
- Vitest + Testing Library

## Requirements

- Node.js **20.19+**, **22.12+**, or **24+** (CI uses Node 24)
- npm (the repo has a `package-lock.json`)
- A Supabase project for the auth and waitlist flows

## Local setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Create a Supabase project, then open **SQL Editor** and run
   [`supabase/schema.sql`](./supabase/schema.sql). The script is idempotent but
   stops with an actionable error if existing rows need manual cleanup.

3. In Supabase **Authentication → URL Configuration**, set:

   - **Site URL:** `http://localhost:3000`
   - **Redirect URLs:** `http://localhost:3000/auth/callback`

   Add the production origin and `/auth/callback` URL when you deploy.

4. In Supabase **Authentication → Providers → Email**, keep email confirmation
   enabled for the signup → email → callback flow. Configure the project's
   password policy to match the app's minimum (8 characters, at least one
   letter and one number), or stricter.

5. Copy the example environment file and fill in the values from
   **Project Settings → API**:

   ```bash
   cp .env.example .env.local
   ```

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL. |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Public anon key. RLS is the security boundary. |
   | `NEXT_PUBLIC_SITE_URL` | Yes in production | Canonical origin for auth email and callback redirects. |

   Never put a Supabase service-role key in a `NEXT_PUBLIC_` variable or in the
   browser bundle. `.env.local` is ignored by Git.

6. Start the dev server:

   ```bash
   npm run dev
   ```

   Open <http://localhost:3000>.

## Environment behavior

- The landing page builds and renders without Supabase environment variables.
- Auth pages show a configuration notice when Supabase is absent; the waitlist
  API and auth callback return friendly `503` responses and log which variable
  is missing. Static marketing content is never broken by missing auth
  configuration.
- `NEXT_PUBLIC_SITE_URL` is mandatory in production. It prevents the auth
  callback from deriving redirects from an untrusted `Host` header. Local
  development falls back to `http://localhost:3000`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run build` | Production build and type check. |
| `npm start` | Serve the production build. |
| `npm run lint` | Run ESLint. |
| `npm run typecheck` | Run `tsc --noEmit`. |
| `npm test` | Run Vitest once. |
| `npm run test:watch` | Run Vitest in watch mode. |

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

### Manual auth verification

Run this against a real Supabase project after configuring the environment:

1. Sign up at `/signup` with a new email and a strong password.
2. Confirm the email link lands on `/auth/callback` and redirects to
   `/dashboard`.
3. Log out, then log in at `/login`; `/dashboard` shows the email.
4. Visit `/dashboard` in a logged-out browser; it redirects to `/login`.
5. Log out; `/dashboard` is no longer accessible and a server request after
   logout is rejected.
6. Refresh `/dashboard` while logged in; the session survives.

Automated unit tests mock Supabase and do not replace this manual E2E check.

## Waitlist security

- `/api/waitlist` validates and normalizes email addresses, enforces a source
  allowlist, and uses a hidden honeypot field.
- `supabase/schema.sql` adds length/format constraints, a case-insensitive
  unique index, `NOT NULL` timestamps, an insert-only RLS policy, and
  least-privilege grants. Anonymous users cannot select individual emails.
- `waitlist_count()` is `SECURITY DEFINER`, uses an empty `search_path`, and is
  callable only through explicit grants. The UI does not promise a queue
  position.
- Rate limiting is an **in-process fixed window** (5 submissions per IP per 10
  minutes). It is per instance, not shared, and resets on restart. It is a
  speed bump, not a production abuse boundary.

**Known limitation:** the public anon key can still insert directly through
PostgREST, bypassing `/api/waitlist`. Before launch, add a shared limiter
(Redis/Upstash or a WAF) or revoke anon `INSERT` and write through a
server-only service-role endpoint. Both are infrastructure decisions outside
Phase 1.

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
    supabase/                server and proxy Supabase clients
    supabase-client.ts       cookie-based browser client
    waitlist-service.ts      testable waitlist submission logic
  proxy.ts                   Next.js 16 session-refresh proxy
supabase/schema.sql          waitlist table, RLS, grants, constraints
tests/                       Vitest unit/integration tests
```

## CI

`.github/workflows/ci.yml` runs `npm ci`, lint, type check, tests, a production
build without Supabase credentials, and `npm audit --omit=dev`. The workflow
does not deploy or push anything.

## Remaining Phase 1 configuration

- Apply `supabase/schema.sql` to the development and production Supabase
  projects.
- Set Supabase Auth Site URL / redirect URLs and the password policy in the
  dashboard.
- Run the manual auth checklist above with a real project.
- Decide on a shared rate limiter or service-role waitlist endpoint before
  public launch.
