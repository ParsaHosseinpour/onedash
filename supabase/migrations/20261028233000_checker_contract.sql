-- ============================================================
-- Phase 4A checker contract
-- ============================================================
-- The checker intentionally supports a smaller configuration surface than the
-- Phase 2 schema allowed. Tighten the database so a monitor that the checker
-- cannot execute cannot be saved and then silently ignored.
--
--   * Only GET and HEAD are supported. There are no request bodies or custom
--     headers in Phase 4A.
--   * TLS verification is always required.
--   * Body assertions are not implemented in Phase 4A.
--   * Redirect following is opt-in, capped at five hops, and must have a
--     non-zero hop budget.
--   * The checker has a richer, sanitized error vocabulary. Existing classes
--     remain for compatibility and for future phases.
--
-- This migration does not add a scheduler, worker, result ingestion, or any
-- outbound request. It only aligns the stored monitor/result contract with the
-- checker implemented under worker/checker.
-- ============================================================

alter table public.monitors
  add constraint monitors_method_check
  check (method in ('GET', 'HEAD'));

alter table public.monitors
  add constraint monitors_verify_tls_check
  check (verify_tls);

alter table public.monitors
  add constraint monitors_body_assertion_check
  check (expected_body_text is null and not expected_body_is_regex);

alter table public.monitors
  drop constraint if exists monitors_redirect_check;

alter table public.monitors
  add constraint monitors_redirect_check
  check (
    (follow_redirects and max_redirects between 1 and 5)
    or (not follow_redirects and max_redirects = 0)
  );

alter table public.check_results
  drop constraint if exists check_results_error_class_check;

alter table public.check_results
  add constraint check_results_error_class_check
  check (
    error_class is null
    or error_class in (
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
  );

comment on constraint monitors_method_check on public.monitors is
  'Phase 4A checker supports GET and HEAD only.';
comment on constraint monitors_verify_tls_check on public.monitors is
  'Phase 4A checker never disables TLS certificate verification.';
comment on constraint monitors_body_assertion_check on public.monitors is
  'Phase 4A checker does not implement body assertions.';
comment on constraint monitors_redirect_check on public.monitors is
  'Phase 4A checker follows at most five redirect hops.';
comment on constraint check_results_error_class_check on public.check_results is
  'Sanitized checker error vocabulary, including Phase 4A classes.';
