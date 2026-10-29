-- Monitor management: RLS, roles, cross-tenant denial, and the development
-- per-organization limit.
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
  '51111111-1111-4111-8111-111111111111',
  'mgmt-owner-a@test.local',
  'Management Owner A'
);
select pg_temp.create_test_user(
  '52222222-2222-4222-8222-222222222222',
  'mgmt-member-a@test.local',
  'Management Member A'
);
select pg_temp.create_test_user(
  '53333333-3333-4333-8333-333333333333',
  'mgmt-viewer-a@test.local',
  'Management Viewer A'
);
select pg_temp.create_test_user(
  '54444444-4444-4444-8444-444444444444',
  'mgmt-owner-b@test.local',
  'Management Owner B'
);
select pg_temp.create_test_user(
  '57777777-7777-4777-8777-777777777777',
  'mgmt-owner-c@test.local',
  'Management Owner C'
);

update public.organizations
set name = 'Management Org A', slug = 'mgmt-org-a'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '51111111-1111-4111-8111-111111111111'
    and role = 'owner'
  order by created_at, id
  limit 1
);

update public.organizations
set name = 'Management Org B', slug = 'mgmt-org-b'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '54444444-4444-4444-8444-444444444444'
    and role = 'owner'
  order by created_at, id
  limit 1
);

update public.organizations
set name = 'Management Org C', slug = 'mgmt-org-c'
where id = (
  select organization_id
  from public.organization_members
  where user_id = '57777777-7777-4777-8777-777777777777'
    and role = 'owner'
  order by created_at, id
  limit 1
);

insert into public.organization_members (organization_id, user_id, role)
select id, '52222222-2222-4222-8222-222222222222', 'member'
from public.organizations where slug = 'mgmt-org-a'
on conflict (organization_id, user_id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select id, '53333333-3333-4333-8333-333333333333', 'viewer'
from public.organizations where slug = 'mgmt-org-a'
on conflict (organization_id, user_id) do nothing;

insert into public.monitors (
  id, organization_id, created_by, name, url, interval_seconds, timeout_seconds
)
values
  (
    '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'mgmt-org-a'),
    '51111111-1111-4111-8111-111111111111',
    'Org A monitor',
    'https://a.mgmt.test/health',
    300,
    10
  ),
  (
    '5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'mgmt-org-b'),
    '54444444-4444-4444-8444-444444444444',
    'Org B monitor',
    'https://b.mgmt.test/health',
    300,
    10
  );

-- ============================================================
-- Limit configuration and function shape
-- ============================================================
select is(
  (select relrowsecurity from pg_class where oid = 'public.monitor_limit_settings'::regclass),
  true,
  'monitor limit settings table has RLS enabled'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'monitor_limit_settings'),
  0,
  'monitor limit settings table has no anon/authenticated policies'
);

select is(
  public.monitor_limit_per_org(),
  25,
  'the documented development limit defaults to 25'
);

select is(
  (select count(*)::int from pg_trigger where tgname = 'monitors_enforce_limit'),
  1,
  'monitors have a BEFORE INSERT limit trigger'
);

-- ============================================================
-- Anonymous access
-- ============================================================
set local role anon;

select throws_ok(
  'select * from public.monitors',
  '42501',
  null,
  'anon cannot read monitors'
);

select throws_ok(
  'select public.monitor_limit_per_org()',
  '42501',
  null,
  'anon cannot execute the monitor limit function'
);

select throws_ok(
  'select * from public.monitor_limit_settings',
  '42501',
  null,
  'anon cannot read monitor limit settings'
);

-- ============================================================
-- Owner A: same-tenant access and cross-tenant denial
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"51111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.monitors),
  1,
  'owner A sees only their organization monitor'
);

select is(
  (select count(*)::int from public.monitors where id = '5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'owner A cannot read the other organization monitor'
);

with changed as (
  update public.monitors
  set name = 'Hijacked'
  where id = '5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'owner A cannot update the other organization monitor'
);

with removed as (
  delete from public.monitors
  where id = '5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  returning 1
)
select is(
  (select count(*)::int from removed),
  0,
  'owner A cannot delete the other organization monitor'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url
     ) values (
       (select id from public.organizations where slug = 'mgmt-org-b'),
       '51111111-1111-4111-8111-111111111111',
       'Cross-tenant insert',
       'https://cross.mgmt.test/health'
     ) $$,
  '42501',
  null,
  'owner A cannot insert a monitor into another organization'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url
     ) values (
       (select id from public.organizations where slug = 'mgmt-org-a'),
       '52222222-2222-4222-8222-222222222222',
       'Forged creator',
       'https://forged.mgmt.test/health'
     ) $$,
  '42501',
  null,
  'the creator must be the authenticated user'
);

select lives_ok(
  $$ insert into public.monitors (
       id, organization_id, created_by, name, url,
       method, expected_status_codes, interval_seconds, timeout_seconds
     ) values (
       '5ccccccc-cccc-4ccc-8ccc-cccccccccccc',
       (select id from public.organizations where slug = 'mgmt-org-a'),
       '51111111-1111-4111-8111-111111111111',
       'Owner-created monitor',
       'https://owner.mgmt.test/health',
       'HEAD',
       array[200, 204],
       600,
       15
     ) $$,
  'an owner can create a monitor in their organization'
);

select is(
  (select name from public.monitors where id = '5ccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'Owner-created monitor',
  'the created monitor is visible to its owner'
);

select lives_ok(
  $$ update public.monitors
     set name = 'Owner-edited monitor',
         expected_status_codes = array[200, 204, 206]
     where id = '5ccccccc-cccc-4ccc-8ccc-cccccccccccc' $$,
  'an owner can edit a monitor in their organization'
);

select is(
  (select name from public.monitors where id = '5ccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'Owner-edited monitor',
  'the edited monitor name is persisted'
);

select lives_ok(
  $$ delete from public.monitors
     where id = '5ccccccc-cccc-4ccc-8ccc-cccccccccccc' $$,
  'an owner can delete a monitor in their organization'
);

select is(
  (select count(*)::int from public.monitors where id = '5ccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  0,
  'the deleted monitor is gone'
);

-- ============================================================
-- Member A: can write; viewer A: read-only
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"52222222-2222-4222-8222-222222222222","role":"authenticated"}';
set local role authenticated;

select lives_ok(
  $$ insert into public.monitors (
       id, organization_id, created_by, name, url
     ) values (
       '5ddddddd-dddd-4ddd-8ddd-dddddddddddd',
       (select id from public.organizations where slug = 'mgmt-org-a'),
       '52222222-2222-4222-8222-222222222222',
       'Member-created monitor',
       'https://member.mgmt.test/health'
     ) $$,
  'a member can create a monitor'
);

select lives_ok(
  $$ update public.monitors
     set url = 'https://member.mgmt.test/health-v2'
     where id = '5ddddddd-dddd-4ddd-8ddd-dddddddddddd' $$,
  'a member can edit a monitor'
);

select lives_ok(
  $$ delete from public.monitors
     where id = '5ddddddd-dddd-4ddd-8ddd-dddddddddddd' $$,
  'a member can delete a monitor'
);

reset role;
set local request.jwt.claims = '{"sub":"53333333-3333-4333-8333-333333333333","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.monitors),
  1,
  'a viewer can read monitors in their organization'
);

select throws_ok(
  $$ insert into public.monitors (
       organization_id, created_by, name, url
     ) values (
       (select id from public.organizations where slug = 'mgmt-org-a'),
       '53333333-3333-4333-8333-333333333333',
       'Viewer-created monitor',
       'https://viewer.mgmt.test/health'
     ) $$,
  '42501',
  null,
  'a viewer cannot create a monitor'
);

with changed as (
  update public.monitors
  set name = 'Viewer edit'
  where id = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'a viewer cannot update a monitor'
);

with removed as (
  delete from public.monitors
  where id = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from removed),
  0,
  'a viewer cannot delete a monitor'
);

select throws_ok(
  'update public.monitor_limit_settings set limit_per_org = 999',
  '42501',
  null,
  'authenticated users cannot raise the monitor limit'
);

select throws_ok(
  'select * from public.monitor_limit_settings',
  '42501',
  null,
  'authenticated users cannot read monitor limit settings'
);

-- ============================================================
-- Owner B: cross-tenant denial in the other direction
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"54444444-4444-4444-8444-444444444444","role":"authenticated"}';
set local role authenticated;

select is(
  (select count(*)::int from public.monitors),
  1,
  'owner B sees only their organization monitor'
);

with changed as (
  update public.monitors
  set name = 'Hijacked B'
  where id = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from changed),
  0,
  'owner B cannot update Org A monitor'
);

with removed as (
  delete from public.monitors
  where id = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  returning 1
)
select is(
  (select count(*)::int from removed),
  0,
  'owner B cannot delete Org A monitor'
);

-- ============================================================
-- Development limit: enforcement and lock
-- ============================================================
reset role;
update public.monitor_limit_settings set limit_per_org = 2;

set local request.jwt.claims = '{"sub":"57777777-7777-4777-8777-777777777777","role":"authenticated"}';
set local role authenticated;

select is(
  public.monitor_limit_per_org(),
  2,
  'authenticated users see the operator-configured limit'
);

select lives_ok(
  $$ insert into public.monitors (
       id, organization_id, created_by, name, url
     ) values (
       '5eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
       (select id from public.organizations where slug = 'mgmt-org-c'),
       '57777777-7777-4777-8777-777777777777',
       'Limit monitor 1',
       'https://limit-1.mgmt.test/health'
     ) $$,
  'the first monitor under the limit is accepted'
);

select lives_ok(
  $$ insert into public.monitors (
       id, organization_id, created_by, name, url
     ) values (
       '5fffffff-ffff-4fff-8fff-ffffffffffff',
       (select id from public.organizations where slug = 'mgmt-org-c'),
       '57777777-7777-4777-8777-777777777777',
       'Limit monitor 2',
       'https://limit-2.mgmt.test/health'
     ) $$,
  'the last monitor under the limit is accepted'
);

select throws_ok(
  $$ insert into public.monitors (
       id, organization_id, created_by, name, url
     ) values (
       '5abcdef0-1234-4abc-8def-abcdef012345',
       (select id from public.organizations where slug = 'mgmt-org-c'),
       '57777777-7777-4777-8777-777777777777',
       'Over limit',
       'https://limit-3.mgmt.test/health'
     ) $$,
  'P0001',
  'Monitor limit reached for this organization (2).',
  'the database rejects an authenticated insert over the limit'
);

reset role;

select throws_ok(
  $$ insert into public.monitors (
       id, organization_id, created_by, name, url
     ) values (
       '5abcdef1-1234-4abc-8def-abcdef012345',
       (select id from public.organizations where slug = 'mgmt-org-c'),
       '57777777-7777-4777-8777-777777777777',
       'Over limit as postgres',
       'https://limit-4.mgmt.test/health'
     ) $$,
  'P0001',
  'Monitor limit reached for this organization (2).',
  'the database limit also applies to direct privileged inserts'
);

select ok(
  exists (
    select 1
    from pg_locks l
    where l.locktype = 'advisory'
      and l.pid = pg_backend_pid()
      and l.granted
      and l.classid = (
        (
          pg_catalog.hashtextextended(
            'onedash-monitor-limit:' || (
              select id::text from public.organizations where slug = 'mgmt-org-c'
            ),
            0
          ) >> 32
        ) & 4294967295
      )::oid
      and l.objid = (
        pg_catalog.hashtextextended(
          'onedash-monitor-limit:' || (
            select id::text from public.organizations where slug = 'mgmt-org-c'
          ),
          0
        ) & 4294967295
      )::oid
  ),
  'a monitor insert holds the per-organization advisory lock for the transaction'
);

-- The trigger records configuration changes in the existing audit log.
select ok(
  (
    select count(*) > 0
    from public.audit_logs
    where organization_id = (
      select id from public.organizations where slug = 'mgmt-org-a'
    )
      and entity_type = 'monitors'
  ),
  'monitor changes are recorded in the audit log'
);

select * from finish();
rollback;
