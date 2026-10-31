# OneDash checker foundation (Phase 4A)

This directory contains the Phase 4A HTTP/HTTPS checker. It is a standalone
TypeScript module with no Next.js imports, no database client, and no scheduler.
It is not wired to the application and it does **not** enable customer checks.
The worker service, result ingestion, scheduling, and multi-region execution are
Phase 4B/4C work.

The checker is intentionally independently testable: DNS resolution, the HTTP
transport, and the server limits can be injected in tests. There is no
production environment flag or request option that disables the public-address
policy or SSRF protection.

## Layout

| File | Responsibility |
| --- | --- |
| `checker/checker.ts` | Config normalization, total deadline, redirect orchestration, result mapping, cancellation. |
| `checker/destination.ts` | DNS resolver wrapper, validation of every answer, mixed-answer rejection, one-address pinning. |
| `checker/ip-policy.ts` | `ipaddr.js` parsing and the public-address policy. |
| `checker/url-policy.ts` | Absolute URL, scheme, credential, port, hostname, and redirect-target validation. |
| `checker/transport.ts` | Undici transport with a pinned connector, TLS verification, SNI/Host preservation, response-size cap, and error classification. |
| `checker/limits.ts` | Server-enforced ceilings and test-only lowering of limits. |
| `checker/runner.ts` | Bounded-concurrency runner with cancellation and first-error propagation. |
| `checker/errors.ts` | Sanitized error vocabulary and fixed user-facing messages. |

Tests live in `tests/checker/` and run with:

```bash
npm run test:checker
```

The tests use fake DNS/transport implementations and local loopback HTTP/HTTPS
servers. They do not depend on arbitrary external websites. The local TLS
fixture is test-only and is not a production certificate.

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
4. One validated address is pinned. The transport connector ignores the URL
   hostname for name resolution and dials the pinned address directly. The
   original hostname remains the HTTP `Host` header and the TLS SNI/certificate
   verification name.
5. TLS verification is enabled with `rejectUnauthorized: true`, TLS 1.2 or
   newer, and HTTP/1.1 ALPN. A separate unchecked DNS lookup is not performed.
6. Redirects are never followed automatically. Each hop is re-parsed,
   revalidated, re-resolved, re-pinned, and re-checked against the loop and hop
   limits. A redirect to a blocked address is `blocked_target`; a malformed,
   credential-bearing, or unsupported redirect is `redirect_failure`.
7. The response body is read only up to the byte cap, counted, and discarded.
   Bodies are never stored or returned.

## Limits

| Limit | Default ceiling |
| --- | --- |
| Total check duration | 60 seconds (monitor timeout is 1–60 s) |
| DNS resolution | 5 seconds |
| Connect | 10 seconds |
| Response body | 1 MiB |
| Redirects | 5 hops |
| Concurrency | 10 checks per runner |
| URL length | 2,048 characters |
| Expected status codes | 20 |

The worker ceiling is enforced in code and cannot be raised by a monitor or by
an environment variable. Test overrides may only lower the ceilings.

## Result vocabulary

`checkMonitor` returns a sanitized `CheckResult` with `status`, `httpStatus`,
timings, `errorClass`, a fixed `errorMessage`, redirect count, body-byte count,
and `checkedAt`.

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

## Known limitations

- No scheduler, queue, leases, worker service, database ingestion, idempotent
  persistence, metrics, or multi-region execution. Phase 4 is not complete.
- No body assertions, custom headers, request bodies, encrypted request
  secrets, certificate-expiry capture, or latency-threshold evaluation.
- The production DNS resolver is the system resolver (`dns.lookup`). The
  wrapper bounds the wait, but the underlying OS lookup cannot be cancelled.
- The TLS tests prove certificate-verification failure, SNI preservation, and
  plaintext rejection with a local self-signed fixture. They do not prove a
  successful handshake against a publicly trusted certificate; that is left to
  deployment smoke tests.
- No hosted deployment or egress firewall is configured in this repository.
  The egress requirements above are a deployment gate.
- No load/capacity test has been run for the proposed 1,000-monitor target.
