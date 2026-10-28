-- Tenant isolation, role permissions, account bootstrap, and worker grants.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select no_plan();

-- The local test runner connects as postgres. Allow it to assume the
-- NOLOGIN worker group role so the worker policies can be exercised.
grant onedash_worker to postgres with set true;

-- pgTAP lives in the extensions schema; the worker role needs to see the
-- assertion helpers while it is the active role.
grant usage on schema extensions to onedash_worker;
grant execute on all functions in schema extensions to onedash_worker;

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
  '21111111-1111-4111-8111-111111111111',
  'owner-a@test.local',
  'Owner A'
);
select pg_temp.create_test_user(
  '22222222-2222-4222-8222-222222222222',
  'admin-a@test.local',
  'Admin A'
);
select pg_temp.create_test_user(
  '23333333-3333-4333-8333-333333333333',
  'member-a@test.local',
  'Member A'
);
select pg_temp.create_test_user(
  '24444444-4444-4444-8444-444444444444',
  'viewer-a@test.local',
  'Viewer A'
);
select pg_temp.create_test_user(
  '25555555-5555-4555-8555-555555555555',
  'owner-b@test.local',
  'Owner B'
);
select pg_temp.create_test_user(
  '26666666-6666-4666-8666-666666666666',
  'new-member@test.local',
  'New Member'
);

-- Rename the two personal organizations created by the bootstrap trigger.
update public.organizations
set name = 'Org A', slug = 'org-a'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '21111111-1111-4111-8111-111111111111'
    and role = 'owner'
  order by created_at, id
  limit 1
);

update public.organizations
set name = 'Org B', slug = 'org-b'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '25555555-5555-4555-8555-555555555555'
    and role = 'owner'
  order by created_at, id
  limit 1
);

insert into public.organization_members (organization_id, user_id, role)
select id, '22222222-2222-4222-8222-222222222222', 'admin'
from public.organizations where slug = 'org-a'
on conflict (organization_id, user_id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select id, '23333333-3333-4333-8333-333333333333', 'member'
from public.organizations where slug = 'org-a'
on conflict (organization_id, user_id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select id, '24444444-4444-4444-8444-444444444444', 'viewer'
from public.organizations where slug = 'org-a'
on conflict (organization_id, user_id) do nothing;

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
values
  (
    '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'org-a'),
    '21111111-1111-4111-8111-111111111111',
    'Org A API',
    'https://api.a.test/health',
    300,
    10
  ),
  (
    '2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'org-b'),
    '25555555-5555-4555-8555-555555555555',
    'Org B API',
    'https://api.b.test/health',
    300,
    10
  );

insert into public.check_results (
  organization_id, monitor_id, region, status, http_status,
  response_time_ms, total_ms, checked_at, idempotency_key
)
values
  (
    (select id from public.organizations where slug = 'org-a'),
    '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'us-east', 'up', 200, 100, 120, now(), 'org-a-seed-1'
  ),
  (
    (select id from public.organizations where slug = 'org-b'),
    '2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'us-east', 'up', 200, 110, 130, now(), 'org-b-seed-1'
  );

insert into public.incidents (
  id, organization_id, monitor_id, status, title, started_at
)
values
  (
    '2ccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select id from public.organizations where slug = 'org-a'),
    '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'investigating',
    'Org A incident',
    now()
  ),
  (
    '2ddddddd-dddd-4ddd-8ddd-dddddddddddd',
    (select id from public.organizations where slug = 'org-b'),
    '2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'investigating',
    'Org B incident',
    now()
  );

insert into public.monitor_state (
  monitor_id, organization_id, status, open_incident_id
)
values
  (
    '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'org-a'),
    'down',
    '2ccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  (
    '2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'org-b'),
    'down',
    '2ddddddd-dddd-4ddd-8ddd-dddddddddddd'
  );

insert into public.alert_channels (
  id, organization_id, created_by, name, kind, config
)
values
  (
    '2eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    (select id from public.organizations where slug = 'org-a'),
    '21111111-1111-4111-8111-111111111111',
    'Org A email',
    'email',
    '{"address":"ops@a.test"}'::jsonb
  ),
  (
    '2fffffff-ffff-4fff-8fff-ffffffffffff',
    (select id from public.organizations where slug = 'org-b'),
    '25555555-5555-4555-8555-555555555555',
    'Org B email',
    'email',
    '{"address":"ops@b.test"}'::jsonb
  );

insert into public.alert_channel_secrets (
  channel_id, organization_id, ciphertext, encryption_key_id
)
values
  (
    '2eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    (select id from public.organizations where slug = 'org-a'),
    decode('aabbcc', 'hex'),
    'test-key'
  ),
  (
    '2fffffff-ffff-4fff-8fff-ffffffffffff',
    (select id from public.organizations where slug = 'org-b'),
    decode('ddeeff', 'hex'),
    'test-key'
  );

-- ============================================================
-- Anonymous
-- ============================================================
set local role anon;

select throws_ok(
  'select * from public.monitors',
  '42501',
  null,
  'anon cannot read monitors'
);

select throws_ok(
  'select * from public.check_results',
  '42501',
  null,
  'anon cannot read check results'
);

select throws_ok(
  'select * from public.incidents',
  '42501',
  null,
  'anon cannot read incidents'
);

select throws_ok(
  'select * from public.alert_channels',
  '42501',
  null,
  'anon cannot read alert configuration'
);

select throws_ok(
  'select * from public.alert_channel_secrets',
  '42501',
  null,
  'anon cannot read alert secrets'
);

select throws_ok(
  'select * from public.monitor_request_secrets',
  '42501',
  null,
  'anon cannot read monitor request secrets'
);

select throws_ok(
  'select * from public.waitlist',
  '42501',
  null,
  'anon cannot read waitlist emails'
);

select lives_ok(
  'select public.waitlist_count()',
  'anon can call the aggregate waitlist count'
);

select lives_ok(
  'select * from public.public_status_pages',
  'anon can query the public status-page view'
);

-- ============================================================
-- Owner A (same tenant)
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"21111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.monitors),
  1,
  'owner sees only their organization monitor'
);

select is(
  (select count(*)::int from public.check_results),
  1,
  'owner sees only their organization check results'
);

select is(
  (select count(*)::int from public.incidents),
  1,
  'owner sees only their organization incidents'
);

select is(
  (select count(*)::int from public.alert_channels),
  1,
  'owner sees only their organization alert channels'
);

select is(
  (select count(*)::int from public.organization_members),
  4,
  'owner sees all four memberships in their organization'
);

select is(
  (select count(*)::int from public.organization_directory),
  4,
  'owner sees the co-member directory'
);

select is(
  (select count(*)::int from public.profiles where id = '21111111-1111-4111-8111-111111111111'),
  1,
  'owner can read their own profile columns'
);

select throws_ok(
  'select * from public.profiles',
  '42501',
  null,
  'profile email is not exposed by a table-wide select'
);

select throws_ok(
  'select config from public.alert_channels',
  '42501',
  null,
  'alert-channel config is not exposed by normal queries'
);

select throws_ok(
  'select * from public.monitor_request_secrets',
  '42501',
  null,
  'owner cannot read monitor request secrets'
);

select throws_ok(
  'select * from public.alert_channel_secrets',
  '42501',
  null,
  'owner cannot read alert secrets'
);

select ok(
  (select count(*) from public.audit_logs) > 0,
  'owner can read audit logs for their organization'
);

select is(
  (select count(*)::int from public.check_results
   where organization_id = (select id from public.organizations where slug = 'org-b')),
  0,
  'owner cannot see the other tenant check results'
);

select is(
  (select count(*)::int from public.incidents
   where organization_id = (select id from public.organizations where slug = 'org-b')),
  0,
  'owner cannot see the other tenant incidents'
);

select is(
  (select count(*)::int from public.alert_channels
   where organization_id = (select id from public.organizations where slug = 'org-b')),
  0,
  'owner cannot see the other tenant alert channels'
);

-- ============================================================
-- Owner B (other tenant)
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"25555555-5555-4555-8555-555555555555","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.monitors),
  1,
  'other-tenant owner sees only their own monitor'
);

select is(
  (select count(*)::int from public.check_results),
  1,
  'other-tenant owner sees only their own check results'
);

select is(
  (select count(*)::int from public.incidents),
  1,
  'other-tenant owner sees only their own incidents'
);

select is(
  (select count(*)::int from public.alert_channels),
  1,
  'other-tenant owner sees only their own alert channels'
);

select is(
  (select count(*)::int from public.organization_members),
  1,
  'other-tenant owner sees only their own membership'
);

select is(
  (select count(*)::int from public.profiles
   where id = '21111111-1111-4111-8111-111111111111'),
  0,
  'other-tenant owner cannot read the first owner profile'
);

with changed as (
  update public.monitors
  set name = 'hijacked'
  where id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'other-tenant owner cannot update the first tenant monitor'
);

with deleted as (
  delete from public.monitors
  where id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from deleted),
  0,
  'other-tenant owner cannot delete the first tenant monitor'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url
     ) values (
       (select id from public.organizations where slug = 'org-a'),
       '25555555-5555-4555-8555-555555555555',
       'cross-tenant monitor',
       'https://cross.test/health'
     ) $$,
  '42501',
  null,
  'other-tenant owner cannot create a monitor in the first tenant'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, idempotency_key
     ) values (
       (select id from public.organizations where slug = 'org-a'),
       '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'up', 'cross-tenant-result'
     ) $$,
  '42501',
  null,
  'authenticated users cannot insert check results directly'
);

select throws_ok(
  $$ insert into public.incidents (
       organization_id, monitor_id, title
     ) values (
       (select id from public.organizations where slug = 'org-a'),
       '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'cross-tenant incident'
     ) $$,
  '42501',
  null,
  'other-tenant owner cannot create an incident in the first tenant'
);

select throws_ok(
  $$ insert into public.alert_channels (
       organization_id, created_by, name, kind, config
     ) values (
       (select id from public.organizations where slug = 'org-a'),
       '25555555-5555-4555-8555-555555555555',
       'cross-tenant channel',
       'email',
       '{}'::jsonb
     ) $$,
  '42501',
  null,
  'other-tenant owner cannot create an alert channel in the first tenant'
);

-- ============================================================
-- Admin B
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
set local role authenticated;

with changed as (
  update public.organizations
  set name = 'Org A (admin edit)'
  where slug = 'org-a'
  returning 1
)
select is(
  (select count(*)::int from changed),
  1,
  'admin can update the organization'
);

select lives_ok(
  $$ insert into public.organization_members (organization_id, user_id, role)
     select id, '26666666-6666-4666-8666-666666666666', 'member'
     from public.organizations where slug = 'org-a' $$,
  'admin can add a member'
);

select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role)
     select id, '26666666-6666-4666-8666-666666666666', 'owner'
     from public.organizations where slug = 'org-a' $$,
  '42501',
  null,
  'admin cannot grant owner'
);

select lives_ok(
  $$ insert into public.alert_channels (
       organization_id, created_by, name, kind, config
     ) select
       id, '22222222-2222-4222-8222-222222222222', 'Admin channel', 'email',
       '{"address":"admin@a.test"}'::jsonb
     from public.organizations where slug = 'org-a' $$,
  'admin can create an alert channel'
);

select ok(
  (select count(*) from public.audit_logs) > 0,
  'admin can read audit logs'
);

-- ============================================================
-- Member A
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"23333333-3333-4333-8333-333333333333","role":"authenticated"}';
set local role authenticated;

select lives_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url
     ) select
       id, '23333333-3333-4333-8333-333333333333', 'Member monitor',
       'https://member.test/health'
     from public.organizations where slug = 'org-a' $$,
  'member can create a monitor'
);

with changed as (
  update public.monitors
  set name = 'Member edited'
  where id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from changed),
  1,
  'member can update an organization monitor'
);

select throws_ok(
  $$ insert into public.alert_channels (
       organization_id, created_by, name, kind, config
     ) select
       id, '23333333-3333-4333-8333-333333333333', 'Member channel', 'email',
       '{}'::jsonb
     from public.organizations where slug = 'org-a' $$,
  '42501',
  null,
  'member cannot create alert channels'
);

with changed as (
  update public.organizations
  set name = 'Member edit'
  where slug = 'org-a'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'member cannot update the organization'
);

select lives_ok(
  $$ insert into public.incident_updates (
       organization_id, incident_id, author_user_id, update_type, message
     ) values (
       (select id from public.organizations where slug = 'org-a'),
       '2ccccccc-cccc-4ccc-8ccc-cccccccccccc',
       '23333333-3333-4333-8333-333333333333',
       'note',
       'Member note'
     ) $$,
  'member can add an incident update as themselves'
);

select is(
  (
    select count(*)::int
    from public.audit_logs
    where organization_id = (
      select id from public.organizations where slug = 'org-a'
    )
  ),
  0,
  'member cannot read audit logs for the organization'
);

-- ============================================================
-- Viewer A
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"24444444-4444-4444-8444-444444444444","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.monitors) > 0,
  true,
  'viewer can read monitors'
);

select is(
  (select count(*)::int from public.check_results) > 0,
  true,
  'viewer can read check results'
);

select is(
  (select count(*)::int from public.incidents) > 0,
  true,
  'viewer can read incidents'
);

select is(
  (select count(*)::int from public.alert_channels) > 0,
  true,
  'viewer can read alert-channel metadata'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url
     ) select
       id, '24444444-4444-4444-8444-444444444444', 'Viewer monitor',
       'https://viewer.test/health'
     from public.organizations where slug = 'org-a' $$,
  '42501',
  null,
  'viewer cannot create monitors'
);

with changed as (
  update public.monitors
  set name = 'Viewer edit'
  where id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'viewer cannot update monitors'
);

with deleted as (
  delete from public.monitors
  where id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from deleted),
  0,
  'viewer cannot delete monitors'
);

select throws_ok(
  $$ insert into public.incident_updates (
       organization_id, incident_id, author_user_id, update_type, message
     ) values (
       (select id from public.organizations where slug = 'org-a'),
       '2ccccccc-cccc-4ccc-8ccc-cccccccccccc',
       '24444444-4444-4444-8444-444444444444',
       'note',
       'Viewer note'
     ) $$,
  '42501',
  null,
  'viewer cannot add incident updates'
);

with changed as (
  update public.incidents
  set status = 'resolved', resolved_at = now()
  where id = '2ccccccc-cccc-4ccc-8ccc-cccccccccccc'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'viewer cannot resolve incidents'
);

with changed as (
  update public.organizations
  set name = 'Viewer edit'
  where slug = 'org-a'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'viewer cannot update the organization'
);

-- ============================================================
-- Last-owner invariant
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"21111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;

select throws_ok(
  $$ update public.organization_members
     set role = 'admin'
     where organization_id = (select id from public.organizations where slug = 'org-a')
       and user_id = '21111111-1111-4111-8111-111111111111' $$,
  '23514',
  null,
  'the last owner cannot be demoted'
);

select throws_ok(
  $$ delete from public.organization_members
     where organization_id = (select id from public.organizations where slug = 'org-a')
       and user_id = '21111111-1111-4111-8111-111111111111' $$,
  '23514',
  null,
  'the last owner cannot be removed'
);

-- ============================================================
-- Account initialization is idempotent
-- ============================================================
reset role;

select is(
  (
    select count(*)::int
    from public.organizations o
    join public.organization_members m on m.organization_id = o.id
    where m.user_id = '21111111-1111-4111-8111-111111111111'
  ),
  1,
  'bootstrap created exactly one organization for the owner'
);

select is(
  public.ensure_user_account('21111111-1111-4111-8111-111111111111'),
  (select id from public.organizations where slug = 'org-a'),
  're-running account initialization returns the existing organization'
);

select is(
  (
    select count(*)::int
    from public.organizations o
    join public.organization_members m on m.organization_id = o.id
    where m.user_id = '21111111-1111-4111-8111-111111111111'
  ),
  1,
  're-running account initialization does not create a duplicate organization'
);

set local request.jwt.claims = '{"sub":"21111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;

select is(
  public.ensure_my_account(),
  (select id from public.organizations where slug = 'org-a'),
  'ensure_my_account is safe to retry'
);

select throws_ok(
  'select public.ensure_user_account(gen_random_uuid())',
  '42501',
  null,
  'authenticated users cannot call the internal initialization helper'
);

reset role;
set local request.jwt.claims = '{}';
set local role authenticated;

select throws_ok(
  'select public.ensure_my_account()',
  '28000',
  null,
  'ensure_my_account rejects a missing auth identity'
);

reset role;

select throws_ok(
  'select public.ensure_user_account(gen_random_uuid())',
  'P0002',
  null,
  'initialization fails closed for a missing auth user'
);

-- ============================================================
-- Worker role
-- ============================================================
set local role onedash_worker;

select lives_ok(
  'select * from public.monitors',
  'worker can read monitor configuration'
);

select throws_ok(
  'select * from public.profiles',
  '42501',
  null,
  'worker cannot read user profiles'
);

select throws_ok(
  'select * from public.organizations',
  '42501',
  null,
  'worker cannot read organizations'
);

select throws_ok(
  'select * from public.audit_logs',
  '42501',
  null,
  'worker cannot read audit logs'
);

select lives_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, idempotency_key
     ) values (
       (
         select organization_id from public.monitors
         where id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       ),
       '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'up', 'worker-result-1'
     ) $$,
  'worker can ingest a check result'
);

select throws_ok(
  $$ insert into public.check_results (
       organization_id, monitor_id, region, status, idempotency_key
     ) values (
       (
         select organization_id from public.monitors
         where id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       ),
       '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'us-east', 'up', 'worker-result-1'
     ) $$,
  '23505',
  null,
  'worker retries are idempotent'
);

select lives_ok(
  $$ update public.monitor_state
     set consecutive_successes = consecutive_successes + 1
     where monitor_id = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $$,
  'worker can update monitor state'
);

select lives_ok(
  'select * from public.alert_channel_secrets',
  'worker can read the encrypted alert credentials it needs to deliver alerts'
);

select * from finish();
rollback;
