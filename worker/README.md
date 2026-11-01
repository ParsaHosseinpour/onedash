# OneDash checker foundation (Phase 4A/4A.1)

This directory contains the Phase 4A.1 HTTP/HTTPS checker. It is a standalone
TypeScript module with no Next.js imports, no database client, and no scheduler.
It is not wired to the application and it does **not** enable customer checks.
The worker service, result ingestion, scheduling, and multi-region execution are
Phase 4B/4C work.

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
`response_bytes` columns to `check_results`; ingestion is still Phase 4B work.
Only counters are stored, never a body, header, URL, hostname, query string, or
secret.

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

## Worker role and Phase 4B requirements

The Phase 4A checker does not read or write the database. The existing
`onedash_worker` group role is global and broader than the checker needs. Before
Phase 4B:

- Use a separate login role that is a member of a **checker-specific** group,
  not the current broad `onedash_worker` role.
- Grant the checker only the monitor fields it needs, the schedule/lease fields
  it needs, and `INSERT` on `check_results` with idempotency. Do not grant
  `monitor_request_secrets`, alert-channel secrets, incident management, or
  cross-tenant identity data to the checker unless a later phase explicitly
  requires them.
- Keep the scheduler/ingestor and the checker as separate roles where possible.
  A checker compromise must not become a control-plane or alerting compromise.
- Use a dedicated database credential, not the Supabase service-role key, and
  never put any service-role key in browser code or `NEXT_PUBLIC_*` variables.
- Add heartbeat/lease permissions separately from result ingestion.

The current broad role is documented in `docs/database.md`. It is a known
Phase 2 deviation, not the final Phase 4B permission model.

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

- No scheduler, queue, leases, worker service, database ingestion, idempotent
  persistence, metrics, or multi-region execution. Phase 4 is not complete.
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
