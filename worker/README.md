# OneDash worker, scheduler, and checker (Phase 4B/4C.0)

This directory contains the Phase 4B scheduler, queue client, worker service,
ingestor client, and the Phase 4A.1 HTTP/HTTPS checker. Phase 4C.0 adds residual
security hardening to the worker and database contract. The worker and scheduler
are standalone Node processes with no Next.js imports. The checker itself has no
database client and no scheduler. Phase 4B stores checker output for
operator-allowlisted fixtures only; fixture output is synthetic `.test` data,
not customer uptime, and customer execution is locked and refused.
Multi-region execution and customer activation remain later work.

The checker is intentionally independently testable: DNS resolution, the HTTP
transport, and the server limits can be injected in tests. There is no
production environment flag or request option that disables the public-address
policy, the HTTPS downgrade rule, or SSRF protection. Test-only address and port
seams are rejected unless `NODE_ENV=test`.

## Layout

| File | Responsibility |
| --- | --- |
| `checker/checker.ts` | Config normalization, total deadline, redirect orchestration, bounded address fallback, result mapping, cancellation. |
| `checker/destination.ts` | DNS resolver wrapper, validation of every answer, mixed-answer rejection, and the validated-address list used for fallback. |
| `checker/ip-policy.ts` | `ipaddr.js` parsing and the public-address policy. |
| `checker/url-policy.ts` | Absolute URL, scheme, credential, port, hostname, redirect-target, and HTTPS-downgrade validation. |
| `checker/transport.ts` | Undici transport with a pinned connector, TLS verification, SNI/Host preservation, response-size cap, and error classification. |
| `checker/limits.ts` | Server-enforced ceilings and test-only lowering of limits. |
| `checker/runner.ts` | Bounded-concurrency runner with cancellation and first-error propagation. |
| `checker/errors.ts` | Sanitized error vocabulary and fixed user-facing messages. |
| `config.ts` | Environment validation, fixture-mode lock, customer-mode rejection, and bounded worker/scheduler settings. |
| `logging.ts` | JSON logger, error classification, and reason sanitization. |
| `queue/queue-client.ts` | Restricted queue RPC client for claim/lease/retry/reap/heartbeat/metrics. |
| `ingestor/ingestor-client.ts` | Restricted ingestion RPC client. |
| `ingestor/result-payload.ts` | Strict checker-result-to-ingest-payload mapping. |
| `checker/adapter.ts` | Phase 4A checker reuse, local fixture checker, and locked customer checker. |
| `service/worker-runtime.ts` | Bounded concurrency, lease extension, retries, shutdown, and runtime metrics. |
| `service/health-server.ts` | `/healthz`, `/readyz`, and `/metrics` HTTP endpoints. |
| `service/main.ts` | Worker process entry point and graceful signal handling. |
| `scheduler/scheduler-client.ts` | Restricted scheduler RPC client, including bounded stale-heartbeat cleanup. |
| `scheduler/scheduler-runtime.ts` | Scheduler loop, lease reaping, hourly heartbeat cleanup, heartbeat, and metrics. |
| `scheduler/main.ts` | Scheduler process entry point and graceful signal handling. |

Tests live in `tests/checker/` and run with:

```bash
npm run test:checker
```

The tests use fake DNS/transport implementations and local loopback HTTP/HTTPS
servers. They do not depend on arbitrary external websites. TLS keys and
certificates are generated into an OS temporary directory during the test run;
no private key or certificate is committed. If the local OpenSSL CLI or the
Node test-CA API is unavailable, the TLS tests are explicitly skipped
("blocked"), not reported as passed. The IPv6 loopback test is also skipped when
the environment cannot bind `::1`.

Worker and scheduler unit tests:

```bash
npm run test:worker
npm run test:scheduler
```

The database pipeline and residual-concurrency tests require a running local
Supabase database and use disposable restricted-role login roles:

```bash
npm run test:phase4b
```

The suite covers the original four-connection pipeline plus independent-
connection cap races, per-monitor advisory-lock namespaces, multi-row inserts,
concurrent identical ingestion, and ingestion rejection/no-write behavior.

## Phase 4B runtime

The scheduler and worker are separate long-running Node processes. The worker
uses two restricted PostgreSQL connections: one for the queue role and one for
the ingestor role. The scheduler uses a third restricted connection. The checker
receives no database client and no service-role key.

### Modes

| Mode | Behavior |
| --- | --- |
| `disabled` (default) | Heartbeats only. Never claims a job. The scheduler sees the disabled gate and schedules nothing. |
| `fixtures` | Requires `ONEDASH_FIXTURE_HOSTS` and an operator allowlist row. Claims only allowlisted fixture monitors whose host is in that list. Uses the local fixture checker for `.test` hosts. |
| `customer` | **NOT IMPLEMENTED.** Configuration loading rejects the process before it starts. |

The execution gate in `public.monitor_execution_settings` must also be enabled
with `mode = 'fixtures'` before the scheduler creates jobs or the queue returns
one. Both checks are deliberate; either one can stop execution.

### Commands

```bash
npm run worker:build          # compile to dist-worker/
npm run worker:service        # run the worker with tsx
npm run worker:scheduler      # run the scheduler with tsx
npm run worker:start:service  # run the compiled worker
npm run worker:start:scheduler
```

`tsx` and Node read environment variables from the process environment; they do
not automatically load `.env.local`. Export the variables in the shell or use a
process manager. Never commit connection strings or metrics tokens.

### Scheduler heartbeat cleanup

The scheduler calls `onedash_cleanup_stale_heartbeats(86400)` at most once per
hour. Phase 4C.0 makes the function scheduler-only: `onedash_queue` and all
application roles are denied execute. The function deletes heartbeat rows whose
`last_seen_at` is strictly older than 24 hours, in batches of at most 1,000 rows
per statement and 10,000 per call, using `FOR UPDATE SKIP LOCKED`. It runs with
function-level `statement_timeout = 5s` and `lock_timeout = 2s`. The retention
is far longer than the normal scheduler/worker heartbeat interval, so active
services are never deleted. The scheduler uses its existing least-privileged
`onedash_scheduler` connection; no extra role or service is introduced.

A cleanup failure is logged as `heartbeat_cleanup_failed` and recorded in the
last-error metric, but it does not skip lease reaping, scheduling, or the
scheduler heartbeat for that tick. The next attempt is delayed until the next
hourly window so a database problem cannot cause a per-tick retry storm. Scheduler
metrics expose `staleHeartbeatsDeletedTotal` and `lastHeartbeatCleanupAt`.

### Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `ONEDASH_WORKER_EXECUTION_MODE` | `disabled` | `disabled` or `fixtures`; `customer` is rejected. |
| `ONEDASH_QUEUE_DATABASE_URL` | required | Login role granted `onedash_queue`. |
| `ONEDASH_INGESTOR_DATABASE_URL` | required | Login role granted `onedash_ingestor`. |
| `ONEDASH_SCHEDULER_DATABASE_URL` | required for scheduler | Login role granted `onedash_scheduler`. |
| `ONEDASH_DB_SSL` | `false` | Set `true` for a hosted database that requires TLS. |
| `ONEDASH_REGION` | `local-1` | Worker region; must match a scheduled job region. |
| `ONEDASH_SCHEDULER_REGION` | `global` | Scheduler heartbeat/region label. |
| `ONEDASH_WORKER_ID` | `worker-<pid>` | Unique worker instance id. |
| `ONEDASH_SCHEDULER_ID` | `scheduler-<pid>` | Unique scheduler instance id. |
| `ONEDASH_WORKER_CONCURRENCY` | `2` | 1-10 in-flight checks. |
| `ONEDASH_LEASE_SECONDS` | `120` | 30-600 seconds. |
| `ONEDASH_POLL_INTERVAL_MS` | `1000` | 250-60,000 ms. |
| `ONEDASH_HEARTBEAT_INTERVAL_MS` | `5000` | 1,000-60,000 ms. |
| `ONEDASH_REAP_INTERVAL_MS` | `5000` | 1,000-60,000 ms. |
| `ONEDASH_SHUTDOWN_GRACE_MS` | `15000` | 1,000-60,000 ms. |
| `ONEDASH_FIXTURE_HOSTS` | empty | Comma-separated `.test` hosts; required in fixtures mode. |
| `ONEDASH_HEALTH_HOST` | `127.0.0.1` | Non-loopback requires a metrics token. |
| `ONEDASH_HEALTH_PORT` | `9464` | 1-65,535. |
| `ONEDASH_METRICS_TOKEN` | none | At least 16 characters; bearer token for `/readyz` and `/metrics`. |
| `ONEDASH_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `ONEDASH_SCHEDULER_INTERVAL_MS` | `5000` | 1,000-60,000 ms. |
| `ONEDASH_SCHEDULER_BATCH_SIZE` | `50` | 1-100 schedules per tick. |
| `ONEDASH_SCHEDULER_JITTER_SECONDS` | `10` | 0-30 seconds of deterministic per-slot jitter. |

### Health and metrics

The worker serves:

- `GET /healthz` - process liveness, always `200` while the HTTP server is up.
- `GET /readyz` - pings both restricted database connections and reports the
  worker's execution mode, in-flight count, and readiness. Returns `503` when a
  connection or the runtime is not ready.
- `GET /metrics` - runtime counters plus aggregate queue metrics. The aggregate
  query returns counts, ages, and durations; it never returns customer URLs,
  hostnames, monitor IDs, organization IDs, or secrets.

`/readyz` and `/metrics` require `Authorization: Bearer <ONEDASH_METRICS_TOKEN>`
when a token is configured. The token is required when the health host is not
loopback. Keep the health server on a private network.

Runtime metrics include claimed/completed/failed/retried/released/reaped jobs,
timeouts, ingestion rejections and their last fixed reason, check-duration
count/sum/max, in-flight/concurrency, last claim and heartbeat times, and the
last sanitized error class. Scheduler metrics include ticks, scheduled/skipped
totals, reaped/dead-lettered totals, stale heartbeats deleted, the last cleanup
and heartbeat times, and the last sanitized error class. Queue metrics include
depth, oldest pending age, leased count, expired-lease count, and
completed/failed/retried counters. Phase 4C.0 clamps every queue-metric count,
age, duration, and total to the integer range and ignores malformed legacy
heartbeat concurrency values instead of failing the whole query.

### Queue and ingestion behavior

- Jobs are claimed with `FOR UPDATE SKIP LOCKED`; each claim gets a random
  `lease_token`. A stale worker cannot extend, fail, release, or ingest after
  another worker reclaims the job.
- The worker extends the lease while a check is in flight. If extension fails or
  the lease is lost, it aborts the check instead of writing a result under a
  stale lease.
- Failures are retried with exponential backoff, capped at 300 seconds. The
  default maximum is 5 attempts. Exhausted jobs become `dead_letter`.
- The worker and scheduler reap expired leases. Expired jobs are retried or
  dead-lettered based on their attempt budget.
- Ingestion uses the job row's organization, monitor, region, scheduled slot,
  and idempotency key. The payload cannot select a different monitor or tenant.
  A duplicate ingestion returns the existing result and does not regress monitor
  state.
- Ingestion completes the job in the same transaction. It does not create
  incidents, incident updates, alert deliveries, or notifications.
- Graceful shutdown stops claiming, aborts in-flight checks, releases claimed
  work where possible, waits for the configured grace period, and closes the
  database pools.

### Phase 4C.0 rejection and timeout behavior

- The database returns ingestion rejections as structured JSON with a fixed
  reason and `retryable = false`: `job_not_found`, `monitor_not_found`,
  `execution_disabled`, `monitor_not_authorized`, `lease_mismatch`,
  `lease_mismatch_or_expired`, and `job_completed_without_result`.
- The worker treats those reasons as terminal for its current lease. It does not
  release the job, call `onedash_fail_job`, retry, or acknowledge it. The job is already
  revoked, dead-lettered, completed, or owned by another worker; touching it
  could interfere with that owner. The database remains the final lease
  authority.
- Only an unknown reason marked `retryable = true` uses the bounded retry path
  with `worker_error`. This cannot bypass the job's `max_attempts` budget, and
  `fail_job` still checks the lease token.
- A completed job without a stored result is logged as `ingest_inconsistent`
  and sets the last error class to `worker_error`; it is never retried.
- Runtime metrics expose `ingestRejectedTotal` and
  `lastIngestRejectionReason`; logs contain the fixed reason and job ID only,
  never a URL, hostname, payload, or database error text.
- Every worker database pool sets `statement_timeout = 15s`,
  `lock_timeout = 5s`, and `idle_in_transaction_session_timeout = 10s` by
  default. These protect queue, ingestor, scheduler, and health queries from a
  stuck lock or an abandoned transaction. The cleanup function has its own
  tighter database-side timeouts.

### Data-plane permissions

The migration creates `onedash_scheduler`, `onedash_queue`, and
`onedash_ingestor` as NOLOGIN group roles. Create one LOGIN role per process and
grant exactly one group role:

```sql
create role onedash_worker_login login password '...';
grant onedash_queue to onedash_worker_login;
```

Do not reuse the Supabase service-role key or the legacy `onedash_worker` role.
The legacy role has no direct table, sequence, function, schema, or policy
grants; `PUBLIC` still exposes schema `USAGE`, but it has no data access. The
new group roles have no direct table access either; they only execute their
restricted functions. The checker module has no database credential and no
service-role key.

Phase 4C.0 revokes default function EXECUTE for future functions created by
`postgres` and `onedash_function_owner` from PUBLIC and application roles. The
local `postgres` role is not a member of `supabase_admin`, so it cannot alter
that superuser's defaults or revoke PUBLIC on its functions. The migration
reports this as a notice; an operator must run the documented superuser
statements before relying on the hardening for `supabase_admin`-owned functions.

### Activation prerequisites

Do not enable customer monitoring with Phase 4B. The scheduler and claim
function intentionally refuse `customer` mode even if the gate is changed. A
later phase must:

1. Implement the production egress-isolated worker host and verify network
   denial for private, loopback, link-local, metadata, control-plane, and
   Supabase private networks.
2. Record that verification in
   `monitor_execution_settings.egress_verified_at/by`.
3. Add the customer scheduling/claim path, multi-region routing, and the
   confirmation/quorum policy.
4. Add load, failure-injection, and hosted operational tests.
5. Obtain explicit approval before changing the gate.

## Supported contract

The checker reuses the Phase 3 monitor fields and rejects anything it cannot
execute rather than silently ignoring it:

- `GET` and `HEAD` only.
- Absolute `http`/`https` URLs with no embedded credentials.
- Ports 80 and 443 only.
- Expected status codes: non-empty, at most 20, each 100–599.
- Timeout: 1–60 seconds; the effective deadline is the smaller of the monitor
  value and the worker ceiling.
- TLS certificate verification is always enabled.
- Redirect following is opt-in. When enabled, the hop budget must be 1–5.
- An HTTPS monitor may redirect to another HTTPS URL, but it may **not**
  downgrade to plaintext HTTP. HTTP-to-HTTPS upgrades and HTTPS-to-HTTPS
  redirects remain allowed. The rule is applied to every hop, so a redirect
  chain cannot bypass it.
- No request bodies, custom headers, request secrets, body-text assertions, or
  regex assertions in Phase 4A. A monitor with those fields produces
  `unsupported_configuration`.
- The result does not contain the URL, hostname, query string, headers, or body.

The database migration `20261028233000_checker_contract.sql` enforces the same
restrictions for stored monitors: `GET`/`HEAD`, `verify_tls = true`, no body
assertions, and redirects capped at five. The checker still validates the
configuration independently because the worker may read a row written before
the migration or by a future code path.

## SSRF and DNS-rebinding defenses

1. The URL is parsed with the WHATWG URL parser. Unusual numeric IPv4 forms
   (decimal, hex, octal, shortened) are normalized before policy checks.
2. Only HTTP/HTTPS, ports 80/443, and unambiguous dotted hostnames or IP
   literals are accepted. Localhost and local-use suffixes are blocked early.
3. Every DNS answer is parsed with `ipaddr.js` and checked against a public
   unicast policy. IPv6 answers must be in the IANA global-unicast `2000::/3`
   prefix (except validated public IPv4-mapped addresses), and the maintained
   range table must classify them as unicast. If any answer is private,
   loopback, link-local, multicast, unspecified, reserved, carrier-grade NAT,
   unique-local, IPv4-mapped private, IPv4-compatible, NAT64, 6to4, Teredo,
   benchmarking, documentation, or otherwise non-global, the whole hostname is
   rejected. The checker does not select a public subset.
4. Every DNS answer is validated before any address is used. The checker then
   pins exactly one validated address per attempt. The transport connector
   ignores the URL hostname for name resolution and dials the pinned address
   directly. The original hostname remains the HTTP `Host` header and the TLS
   SNI/certificate-verification name.
5. TLS verification is enabled with `rejectUnauthorized: true`, TLS 1.2 or
   newer, and HTTP/1.1 ALPN. A separate unchecked DNS lookup is not performed.
6. Redirects are never followed automatically. Each hop is re-parsed,
   revalidated, re-resolved, re-pinned, and re-checked against the loop, hop,
   and HTTPS-downgrade rules. A redirect to a blocked address is
   `blocked_target`; a malformed, credential-bearing, unsupported, or
   HTTPS-to-HTTP redirect is `redirect_failure`.
7. The response body is read only up to the byte cap, counted, and discarded.
   Bodies are never stored or returned.

### Bounded address fallback

- DNS is resolved once per redirect hop. Every answer is validated first; a
  mixed public/private answer is rejected as a whole.
- The checker tries at most **3** validated addresses per hostname per hop.
  The ceiling is server-enforced and test overrides may only lower it.
- Only connection-level failures before an HTTP response are eligible for
  another address: connection refused, other connection failure, or a
  connection/headers/body timeout. A TLS error is not retried, because it is a
  security result rather than a routing failure. A returned HTTP status,
  including 4xx/5xx, is never retried on another address.
- The total request deadline is unchanged. A slow or dead address cannot
  extend it, and no new attempt starts after the deadline or after caller
  cancellation.
- Each attempt still uses the original hostname for TLS SNI and certificate
  verification. The fallback does not disable TLS verification or perform a
  second unchecked DNS lookup.

## Limits

| Limit | Default ceiling |
| --- | --- |
| Total check duration | 60 seconds (monitor timeout is 1–60 s) |
| DNS resolution | 5 seconds |
| Connect | 10 seconds |
| Response body | 1 MiB |
| Redirects | 5 hops |
| Address attempts | 3 validated addresses per hostname per hop |
| Concurrency | 10 checks per runner |
| URL length | 2,048 characters |
| Expected status codes | 20 |

The worker ceiling is enforced in code and cannot be raised by a monitor or by
an environment variable. Test overrides may only lower the ceilings.

## Result vocabulary

`checkMonitor` returns a sanitized `CheckResult` with `status`, `httpStatus`,
timings, `errorClass`, a fixed `errorMessage`, redirect count, body-byte count,
and `checkedAt`. The Phase 4A.1 migration
`20261101090000_check_result_metrics.sql` adds matching `redirect_count` and
`response_bytes` columns to `check_results`; Phase 4B persists them through the
restricted ingestor. Only counters are stored, never a body, header, URL,
hostname, query string, or secret.

| Situation | `status` | `errorClass` |
| --- | --- | --- |
| Expected status | `up` | `null` |
| Unexpected status | `down` | `http_status_mismatch` |
| DNS failure | `error` | `dns_failure` |
| Connection refused | `error` | `connection_refused` |
| Other connection failure | `error` | `connection_failure` |
| Deadline/connect/header/body timeout | `error` | `timeout` |
| TLS verification/protocol failure | `error` | `tls_error` |
| Blocked destination | `error` | `blocked_target` |
| Redirect loop or hop cap | `error` | `redirect_loop` |
| Unsafe/malformed redirect | `error` | `redirect_failure` |
| Response exceeds byte cap | `error` | `response_too_large` |
| Unsupported monitor field | `error` | `unsupported_configuration` |
| Unexpected internal failure | `error` | `internal_error` |

Cancellation is not a result. `checkMonitor` throws `CheckCancelledError` so a
caller cannot persist a cancellation as an outage. The runner waits for
in-flight work to settle before propagating cancellation or the first error.

## Cleanup

Each request gets a fresh Undici `Agent` and a fresh pinned connector. The
agent is destroyed in a `finally` block after success, failure, timeout, or
cancellation. The total-deadline timer and caller abort listener are also
removed in `finally`. A response body that exceeds the cap is destroyed before
the error is returned.

## Checker isolation and remaining deployment gates

The checker module has no database client, no service-role key, and no direct
access to tenant tables. The worker process holds only the restricted queue and
ingestor connections and passes the checker the minimal claimed configuration
in memory. The legacy `onedash_worker` role is deprecated and has no privileges.

Phase 4B does not prove deployment isolation. Before customer checks can be
enabled, the worker host/network must enforce egress isolation and the
activation prerequisites in the Phase 4B runtime section must be met. The
checker's DNS/IP policy is one layer, not a replacement for network policy.

## Deployment egress isolation (release blocker)

Application-level validation is necessary but **not sufficient**. The worker
host/network must enforce egress isolation independently of the checker:

- Deny egress to loopback, RFC1918/private, link-local, multicast, unspecified,
  reserved, carrier-grade NAT, and cloud metadata networks (for example
  `169.254.169.254`, `fd00:ec2::254`, and provider-specific equivalents).
- Deny egress to the control plane, the Supabase private network/database, and
  any internal admin or observability network that is not required for the
  worker.
- Allow only the public destinations and ports the checker is permitted to
  reach (80/443 by default), through a controlled resolver and, if the platform
  cannot enforce address policy, an outbound proxy that enforces it.
- Ensure DNS answers used by the OS/firewall cannot differ from the pinned
  address. The application pin is a second layer, not a replacement for
  network policy.
- Log and alert on blocked egress attempts without logging customer URLs,
  headers, cookies, bodies, or secrets.

If the chosen hosting environment cannot enforce these controls, Phase 4 must
not enable customer checks. Treat that as a release blocker; do not rely on
application validation alone.

**Important limit of application validation:** the checker's URL and IP policy
does **not** protect against every cloud-platform service or metadata address.
Some providers expose metadata or control-plane services on ordinary-looking
public addresses, provider-specific hostnames, or IPv6 ranges that a generic
public-unicast policy cannot enumerate. The application policy is one layer; the
worker deployment must still enforce network egress isolation and a controlled
resolver/firewall. Do not describe application-level URL validation as complete
SSRF protection.

## Database migration preflight (Phase 4A.1)

The stricter Phase 4A monitor migration can fail on legacy Phase 2/3 rows. Run
the read-only check before applying it to any existing database:

```bash
psql "$DATABASE_URL" -f supabase/preflight/phase_4a_monitor_compatibility.sql
```

The script opens a `READ ONLY` transaction, reports monitor IDs and reasons, and
rolls back. It does not delete, disable, or rewrite monitors. Before a future
production migration, an operator must:

1. Run it against a backup/copy or with a read-only role; never from this
   repository against a remote database without explicit approval.
2. Confirm `blocking_monitors = 0`. Review every reported row: method not
   `GET`/`HEAD`, `verify_tls = false`, body/regex assertions, redirect budgets
   outside 1–5, or a non-zero budget when redirects are disabled.
3. Confirm the `check_results.error_class` query is empty (or review any
   unexpected values).
4. Decide each legacy monitor's remediation with its owner. This round does not
   auto-fix, delete, or disable records.
5. Back up the database, apply the migration in staging first, re-run the
   preflight and pgTAP tests, and only then schedule production.

## Known limitations

- Scheduler, durable queue, leases, worker service, restricted ingestion,
  idempotent persistence, and metrics exist for **fixtures only**. Customer
  execution is disabled and `customer` mode is rejected.
- No multi-region execution, confirmation/quorum policy, alert delivery,
  incident automation, hosted deployment, or Docker packaging.
- No body assertions, custom headers, request bodies, encrypted request
  secrets, certificate-expiry capture, or latency-threshold evaluation.
- The production DNS resolver is the system resolver (`dns.lookup`). The
  wrapper bounds the wait, but the underlying OS lookup cannot be cancelled.
  A late answer is ignored and cannot start a request, but the OS lookup may
  continue consuming a resolver slot until it finishes. The total deadline
  bounds the check result, not the OS resolver's internal work.
- The TLS tests now cover a locally trusted test CA, wrong-hostname rejection,
  self-signed rejection, SNI preservation, and a real `checkMonitor` +
  Undici + local TLS server path. They do **not** prove production TLS against
  a publicly trusted CA, a corporate proxy, a custom trust store, or a host with
  clock skew. Those remain deployment smoke tests.
- IPv6 loopback is tested only where the environment can bind `::1`. Production
  IPv6 routing, dual-stack preference, and fallback behavior are unverified.
- The old committed self-signed test key was removed from the current tree and
  test certificates are generated at runtime. It remains in git history at the
  Phase 4A commit; scanners that inspect history may still flag it. It was a
  disposable test key, never a production credential. This round does not
  rewrite history.
- No hosted deployment or egress firewall is configured in this repository.
  The egress requirements above are a deployment gate.
- No load/capacity test has been run for the proposed 1,000-monitor target.
