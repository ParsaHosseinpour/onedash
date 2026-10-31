-- Phase 4A checker contract: monitor restrictions and sanitized error classes.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select no_plan();

create function pg_temp.create_test_user(
  p_id uuid,
  p_email text,
  p_display_name text
)
returns void
language sql
as $$
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, email_change,
    email_change_token_new, recovery_token, raw_app_meta_data,
    raw_user_meta_data, created_at, updated_at
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    p_id,
    'authenticated',
    'authenticated',
    p_email,
    extensions.crypt('test-password1', extensions.gen_salt('bf')),
    now(),
    '',
    '',
    '',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', p_display_name),
    now(),
    now()
  )
  on conflict (id) do nothing;
$$;

select pg_temp.create_test_user(
  '61111111-1111-4111-8111-111111111111',
  'checker-contract@test.local',
  'Checker Contract'
);

update public.organizations
set name = 'Checker Contract Org', slug = 'checker-contract-org'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '61111111-1111-4111-8111-111111111111'
    and role = 'owner'
  order by created_at, id
  limit 1
);

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
values (
  '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select id from public.organizations where slug = 'checker-contract-org'),
  '61111111-1111-4111-8111-111111111111',
  'Checker contract base',
  'https://checker-contract.test/health',
  300,
  10
);

-- ============================================================
-- Monitor configuration restrictions
-- ============================================================
select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, method
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '61111111-1111-4111-8111-111111111111',
       'POST monitor',
       'https://checker-contract.test/post',
       'POST'
     ) $$,
  '23514',
  null,
  'POST monitors are rejected because Phase 4A supports GET/HEAD only'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, verify_tls
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '61111111-1111-4111-8111-111111111111',
       'TLS-off monitor',
       'https://checker-contract.test/tls-off',
       false
     ) $$,
  '23514',
  null,
  'monitors cannot disable TLS verification'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, expected_body_text
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '61111111-1111-4111-8111-111111111111',
       'Body assertion monitor',
       'https://checker-contract.test/body',
       'healthy'
     ) $$,
  '23514',
  null,
  'body text assertions are rejected in Phase 4A'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, expected_body_is_regex
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '61111111-1111-4111-8111-111111111111',
       'Regex assertion monitor',
       'https://checker-contract.test/regex',
       true
     ) $$,
  '23514',
  null,
  'regex body assertions are rejected in Phase 4A'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, follow_redirects, max_redirects
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '61111111-1111-4111-8111-111111111111',
       'Too many redirects',
       'https://checker-contract.test/redirects',
       true,
       6
     ) $$,
  '23514',
  null,
  'the redirect budget cannot exceed five hops'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, follow_redirects, max_redirects
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '61111111-1111-4111-8111-111111111111',
       'Redirect budget without following',
       'https://checker-contract.test/no-follow',
       false,
       1
     ) $$,
  '23514',
  null,
  'a non-zero redirect budget requires follow_redirects'
);

select lives_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, method, expected_status_codes,
       verify_tls, follow_redirects, max_redirects
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '61111111-1111-4111-8111-111111111111',
       'Supported HEAD monitor',
       'https://checker-contract.test/head',
       'HEAD',
       array[200, 204],
       true,
       true,
       5
     ) $$,
  'a supported HEAD monitor with five redirect hops is accepted'
);

-- ============================================================
-- Check-result error vocabulary
-- ============================================================
select lives_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, error_class, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'error',
       'connection_failure',
       'checker-contract-connection-failure'
     ) $$,
  'connection_failure is accepted'
);

select lives_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, error_class, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'error',
       'redirect_failure',
       'checker-contract-redirect-failure'
     ) $$,
  'redirect_failure is accepted'
);

select lives_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, error_class, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'error',
       'response_too_large',
       'checker-contract-response-too-large'
     ) $$,
  'response_too_large is accepted'
);

select lives_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, error_class, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'error',
       'unsupported_configuration',
       'checker-contract-unsupported'
     ) $$,
  'unsupported_configuration is accepted'
);

select lives_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, error_class, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'error',
       'timeout',
       'checker-contract-existing-timeout'
     ) $$,
  'the existing timeout error class remains accepted'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, error_class, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'checker-contract-org'),
       '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'error',
       'made_up_error',
       'checker-contract-unknown-error'
     ) $$,
  '23514',
  null,
  'unknown error classes are rejected'
);

select * from finish();
rollback;
