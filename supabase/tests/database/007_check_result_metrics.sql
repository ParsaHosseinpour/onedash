-- Phase 4A.1: persisted redirect count and response-byte metrics.
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
  '71111111-1111-4111-8111-111111111111',
  'metrics-a@test.local',
  'Metrics A'
);
select pg_temp.create_test_user(
  '72222222-2222-4222-8222-222222222222',
  'metrics-b@test.local',
  'Metrics B'
);

update public.organizations
set name = 'Metrics Org A', slug = 'metrics-org-a'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '71111111-1111-4111-8111-111111111111'
    and role = 'owner'
  order by created_at, id
  limit 1
);

update public.organizations
set name = 'Metrics Org B', slug = 'metrics-org-b'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '72222222-2222-4222-8222-222222222222'
    and role = 'owner'
  order by created_at, id
  limit 1
);

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
values
  (
    '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'metrics-org-a'),
    '71111111-1111-4111-8111-111111111111',
    'Metrics monitor A',
    'https://metrics-a.test/health',
    300,
    10
  ),
  (
    '7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'metrics-org-b'),
    '72222222-2222-4222-8222-222222222222',
    'Metrics monitor B',
    'https://metrics-b.test/health',
    300,
    10
  );

insert into public.check_results (
  organization_id, monitor_id, region, status, http_status,
  redirect_count, response_bytes, idempotency_key
)
values
  (
    (select id from public.organizations where slug = 'metrics-org-a'),
    '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'us-east',
    'up',
    200,
    2,
    1234,
    'metrics-a-result'
  ),
  (
    (select id from public.organizations where slug = 'metrics-org-b'),
    '7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'us-east',
    'up',
    200,
    1,
    10,
    'metrics-b-result'
  );

select is(
  (
    select redirect_count
    from public.check_results
    where idempotency_key = 'metrics-a-result'
  ),
  2,
  'redirect_count is stored'
);

select is(
  (
    select response_bytes
    from public.check_results
    where idempotency_key = 'metrics-a-result'
  ),
  1234,
  'response_bytes is stored'
);

insert into public.check_results (
  organization_id, monitor_id, region, status, http_status, idempotency_key
)
values (
  (select id from public.organizations where slug = 'metrics-org-a'),
  '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'us-east',
  'up',
  204,
  'metrics-a-defaults'
);

select is(
  (
    select redirect_count
    from public.check_results
    where idempotency_key = 'metrics-a-defaults'
  ),
  0,
  'redirect_count defaults to zero'
);

select is(
  (
    select response_bytes
    from public.check_results
    where idempotency_key = 'metrics-a-defaults'
  ),
  null::integer,
  'response_bytes defaults to null when no body was read'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, redirect_count,
       idempotency_key
     ) values (
       (select id from public.organizations where slug = 'metrics-org-a'),
       '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'up',
       -1,
       'metrics-negative-redirects'
     ) $$,
  '23514',
  null,
  'negative redirect_count is rejected'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, response_bytes,
       idempotency_key
     ) values (
       (select id from public.organizations where slug = 'metrics-org-a'),
       '7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east',
       'up',
       -1,
       'metrics-negative-bytes'
     ) $$,
  '23514',
  null,
  'negative response_bytes is rejected'
);

-- Tenant isolation: the new columns are on the existing RLS-protected table,
-- so cross-tenant reads must remain impossible.
reset role;
set local request.jwt.claims = '{"sub":"71111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.check_results),
  2,
  'owner A sees only their own check results, including the new metric columns'
);

select is(
  (
    select count(*)::int
    from public.check_results
    where organization_id = (
      select id from public.organizations where slug = 'metrics-org-b'
    )
  ),
  0,
  'owner A cannot see tenant B check results'
);

reset role;
set local request.jwt.claims = '{"sub":"72222222-2222-4222-8222-222222222222","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.check_results),
  1,
  'owner B sees only their own check result'
);

select is(
  (
    select count(*)::int
    from public.check_results
    where organization_id = (
      select id from public.organizations where slug = 'metrics-org-a'
    )
  ),
  0,
  'owner B cannot see tenant A check results'
);

select * from finish();
rollback;
