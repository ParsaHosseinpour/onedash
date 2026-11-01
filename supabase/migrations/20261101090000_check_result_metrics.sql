-- ============================================================
-- Phase 4A.1 check-result metrics
-- ============================================================
-- The checker already reports the number of redirects it followed and the
-- number of response-body bytes it read (and discarded). Persist those
-- non-sensitive counters so the future result ingestor does not have to throw
-- away information it already has.
--
-- No body, header, URL, hostname, query string, or secret is stored. This is a
-- new migration; the published Phase 4A migration is not modified.
-- ============================================================

alter table public.check_results
  add column redirect_count integer not null default 0,
  add column response_bytes integer;

alter table public.check_results
  add constraint check_results_redirect_count_check
  check (redirect_count >= 0);

alter table public.check_results
  add constraint check_results_response_bytes_check
  check (response_bytes is null or response_bytes >= 0);

comment on column public.check_results.redirect_count is
  'Number of redirect hops followed by the checker. Zero when redirects were not followed.';
comment on column public.check_results.response_bytes is
  'Response-body bytes read and discarded by the checker, or null when no body was read.';
