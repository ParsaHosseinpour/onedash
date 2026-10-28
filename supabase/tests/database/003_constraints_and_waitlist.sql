-- Constraint behavior and waitlist hardening.
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
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
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
  '31111111-1111-4111-8111-111111111111',
  'constraints-a@test.local',
  'Constraints A'
);
select pg_temp.create_test_user(
  '32222222-2222-4222-8222-222222222222',
  'constraints-b@test.local',
  'Constraints B'
);

update public.organizations
set name = 'Constraints Org A', slug = 'constraints-org-a'
where id = (
  select organization_id from public.organization_members
  where user_id = '31111111-1111-4111-8111-111111111111' and role = 'owner'
  order by created_at, id limit 1
);

update public.organizations
set name = 'Constraints Org B', slug = 'constraints-org-b'
where id = (
  select organization_id from public.organization_members
  where user_id = '32222222-2222-4222-8222-222222222222' and role = 'owner'
  order by created_at, id limit 1
);

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
values (
  '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select id from public.organizations where slug = 'constraints-org-a'),
  '31111111-1111-4111-8111-111111111111',
  'Constraints monitor',
  'https://constraints.test/health',
  300,
  10
);

-- ============================================================
-- Monitor constraints
-- ============================================================
select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, interval_seconds, timeout_seconds
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '31111111-1111-4111-8111-111111111111',
       'Credential URL',
       'https://user:pass@constraints.test/health',
       300, 10
     ) $$,
  '23514',
  null,
  'monitor URLs with embedded credentials are rejected'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, interval_seconds, timeout_seconds
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '31111111-1111-4111-8111-111111111111',
       'Bad timeout',
       'https://constraints.test/health',
       60, 60
     ) $$,
  '23514',
  null,
  'timeout must be shorter than the interval'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url, expected_status_codes
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '31111111-1111-4111-8111-111111111111',
       'Bad status array',
       'https://constraints.test/health',
       array[99, 700]
     ) $$,
  '23514',
  null,
  'expected status codes must be valid HTTP statuses'
);

select lives_ok(
  $$ insert into public.monitor_schedules (
       organization_id, monitor_id, region, next_run_at
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', now()
     ) $$,
  'the first schedule for a monitor/region is accepted'
);

select throws_ok(
  $$ insert into public.monitor_schedules (
       organization_id, monitor_id, region, next_run_at
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', now()
     ) $$,
  '23505',
  null,
  'a monitor can have only one schedule per region'
);

-- ============================================================
-- Check-result idempotency and tenant consistency
-- ============================================================
select lives_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'up', 'constraints-result-1'
     ) $$,
  'a check result with a new idempotency key is accepted'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'up', 'constraints-result-1'
     ) $$,
  '23505',
  null,
  'duplicate check-result idempotency keys are rejected'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'constraints-org-b'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'up', 'constraints-result-cross-tenant'
     ) $$,
  '23503',
  null,
  'a check result cannot claim a monitor from another organization'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, error_class, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'up', 'timeout', 'constraints-result-up-error'
     ) $$,
  '23514',
  null,
  'an up result cannot carry an error class'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'down', 'constraints-result-down-no-error'
     ) $$,
  '23514',
  null,
  'a down result must carry an error class'
);

-- ============================================================
-- Incidents
-- ============================================================
select lives_ok(
  $$ insert into public.incidents (
       id, organization_id, monitor_id, status, title, started_at
     ) values (
       '3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'investigating', 'Open incident', now()
     ) $$,
  'the first open incident is accepted'
);

select throws_ok(
  $$ insert into public.incidents (
       organization_id, monitor_id, status, title, started_at
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'investigating', 'Second open incident', now()
     ) $$,
  '23505',
  null,
  'a monitor cannot have two unresolved incidents'
);

select throws_ok(
  $$ insert into public.incidents (
       organization_id, monitor_id, status, title, started_at
     ) values (
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'resolved', 'Resolved without timestamp', now()
     ) $$,
  '23514',
  null,
  'resolved incidents require resolved_at'
);

select lives_ok(
  $$ insert into public.incidents (
       id, organization_id, monitor_id, status, title, started_at, resolved_at
     ) values (
       '3ccccccc-cccc-4ccc-8ccc-cccccccccccc',
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'resolved', 'Historical incident', now() - interval '1 day',
       now() - interval '1 day' + interval '10 minutes'
     ) $$,
  'a resolved incident does not count as open'
);

update public.incidents
set status = 'resolved', resolved_at = now()
where id = '3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

select lives_ok(
  $$ insert into public.incidents (
       id, organization_id, monitor_id, status, title, started_at
     ) values (
       '3ddddddd-dddd-4ddd-8ddd-dddddddddddd',
       (select id from public.organizations where slug = 'constraints-org-a'),
       '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'investigating', 'Reopened incident', now()
     ) $$,
  'a new open incident is allowed after the previous one was resolved'
);

-- ============================================================
-- Waitlist constraints and privileges
-- ============================================================
select lives_ok(
  $$ insert into public.waitlist (email, source)
     values ('person@example.com', 'landing_page') $$,
  'a valid waitlist email is accepted'
);

select throws_ok(
  $$ insert into public.waitlist (email, source)
     values ('person@example.com', 'landing_page') $$,
  '23505',
  null,
  'duplicate waitlist emails are rejected'
);

select throws_ok(
  $$ insert into public.waitlist (email, source)
     values ('Person@Example.com', 'landing_page') $$,
  '23514',
  null,
  'waitlist emails must be normalized before insertion'
);

select throws_ok(
  $$ insert into public.waitlist (email, source)
     values ('not-an-email', 'landing_page') $$,
  '23514',
  null,
  'invalid waitlist emails are rejected'
);

select throws_ok(
  $$ insert into public.waitlist (email, source)
     values (repeat('a', 250) || '@example.com', 'landing_page') $$,
  '23514',
  null,
  'oversized waitlist emails are rejected'
);

select throws_ok(
  $$ insert into public.waitlist (email, source)
     values ('other@example.com', 'admin_panel') $$,
  '23514',
  null,
  'unsupported waitlist sources are rejected'
);

set local role anon;

select throws_ok(
  'select * from public.waitlist',
  '42501',
  null,
  'anon cannot read waitlist rows'
);

select throws_ok(
  $$ insert into public.waitlist (email, source)
     values ('anon@example.com', 'landing_page') $$,
  '42501',
  null,
  'anon cannot insert waitlist rows directly'
);

select throws_ok(
  $$ update public.waitlist set email = 'changed@example.com' $$,
  '42501',
  null,
  'anon cannot update waitlist rows'
);

select throws_ok(
  'delete from public.waitlist',
  '42501',
  null,
  'anon cannot delete waitlist rows'
);

select is(
  public.waitlist_count(),
  1::bigint,
  'anon can read only the aggregate waitlist count'
);

select throws_ok(
  'select public.ensure_my_account()',
  '42501',
  null,
  'anon cannot call account initialization'
);

reset role;
set local request.jwt.claims = '{"sub":"31111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;

select throws_ok(
  $$ insert into public.waitlist (email, source)
     values ('authenticated@example.com', 'landing_page') $$,
  '42501',
  null,
  'authenticated users cannot insert waitlist rows directly'
);

select is(
  public.waitlist_count(),
  1::bigint,
  'authenticated users can read only the aggregate waitlist count'
);

-- The service-role key is server-only. It may insert through the trusted route
-- but must not gain a general read path to waitlist emails.
reset role;
set local role service_role;

select throws_ok(
  'select * from public.waitlist',
  '42501',
  null,
  'service role has no direct read access to waitlist rows'
);

select lives_ok(
  $$ insert into public.waitlist (email, source)
     values ('service-role@example.com', 'landing_page') $$,
  'service role can insert through the trusted server path'
);

reset role;

select is(
  (
    select count(*)::int
    from public.waitlist
    where email = 'service-role@example.com'
  ),
  1,
  'the service-role insert was persisted'
);

select * from finish();
rollback;
