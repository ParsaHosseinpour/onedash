-- Public status pages expose only published, selected, active monitor fields.
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
  '41111111-1111-4111-8111-111111111111',
  'status-a@test.local',
  'Status A'
);
select pg_temp.create_test_user(
  '42222222-2222-4222-8222-222222222222',
  'status-b@test.local',
  'Status B'
);

update public.organizations
set name = 'Status Org A', slug = 'status-org-a'
where id = (
  select organization_id from public.organization_members
  where user_id = '41111111-1111-4111-8111-111111111111' and role = 'owner'
  order by created_at, id limit 1
);

update public.organizations
set name = 'Status Org B', slug = 'status-org-b'
where id = (
  select organization_id from public.organization_members
  where user_id = '42222222-2222-4222-8222-222222222222' and role = 'owner'
  order by created_at, id limit 1
);

insert into public.monitors (
  id, organization_id, created_by, name, url, is_active
)
values
  (
    '4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'status-org-a'),
    '41111111-1111-4111-8111-111111111111',
    'Public API',
    'https://public.status-a.test/health',
    true
  ),
  (
    '4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'status-org-a'),
    '41111111-1111-4111-8111-111111111111',
    'Private admin API',
    'https://private.status-a.test/health',
    true
  ),
  (
    '4ccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select id from public.organizations where slug = 'status-org-a'),
    '41111111-1111-4111-8111-111111111111',
    'Inactive API',
    'https://inactive.status-a.test/health',
    false
  ),
  (
    '4ddddddd-dddd-4ddd-8ddd-dddddddddddd',
    (select id from public.organizations where slug = 'status-org-b'),
    '42222222-2222-4222-8222-222222222222',
    'Globex Public API',
    'https://public.status-b.test/health',
    true
  );

insert into public.monitor_state (
  monitor_id, organization_id, status, last_checked_at
)
values
  (
    '4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'status-org-a'),
    'up', now()
  ),
  (
    '4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'status-org-a'),
    'down', now()
  ),
  (
    '4ccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select id from public.organizations where slug = 'status-org-a'),
    'up', now()
  ),
  (
    '4ddddddd-dddd-4ddd-8ddd-dddddddddddd',
    (select id from public.organizations where slug = 'status-org-b'),
    'up', now()
  );

insert into public.status_pages (
  id, organization_id, created_by, slug, name, description, is_published
)
values
  (
    '4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    (select id from public.organizations where slug = 'status-org-a'),
    '41111111-1111-4111-8111-111111111111',
    'status-a-public',
    'Status A Public',
    'Public page for Status Org A.',
    true
  ),
  (
    '4fffffff-ffff-4fff-8fff-ffffffffffff',
    (select id from public.organizations where slug = 'status-org-b'),
    '42222222-2222-4222-8222-222222222222',
    'status-b-private',
    'Status B Private',
    'Unpublished page for Status Org B.',
    false
  );

insert into public.status_page_monitors (
  organization_id, status_page_id, monitor_id, display_name, sort_order
)
values
  (
    (select id from public.organizations where slug = 'status-org-a'),
    '4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Public API',
    0
  ),
  (
    (select id from public.organizations where slug = 'status-org-a'),
    '4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '4ccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'Inactive API',
    1
  ),
  (
    (select id from public.organizations where slug = 'status-org-b'),
    '4fffffff-ffff-4fff-8fff-ffffffffffff',
    '4ddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Globex Public API',
    0
  );

-- ============================================================
-- Anonymous access
-- ============================================================
set local role anon;

select is(
  (
    select count(*)::int
    from public.public_status_pages
    where slug = 'status-a-public'
  ),
  1,
  'anon sees the test published status page'
);

select is(
  (
    select count(*)::int
    from public.public_status_pages
    where slug = 'status-a-public'
  ),
  1,
  'anon sees the published slug'
);

select is(
  (
    select count(*)::int
    from public.public_status_page_monitors
    where status_page_slug = 'status-a-public'
  ),
  1,
  'anon sees only the active, selected monitor'
);

select is(
  (
    select monitor_name
    from public.public_status_page_monitors
    where status_page_slug = 'status-a-public'
  ),
  'Public API',
  'anon sees the explicit public display name'
);

select is(
  (
    select count(*)::int
    from public.public_status_page_monitors
    where status_page_slug = 'status-a-public'
      and monitor_name = 'Private admin API'
  ),
  0,
  'a private, unselected monitor does not leak'
);

select is(
  (
    select count(*)::int
    from public.public_status_page_monitors
    where status_page_slug = 'status-a-public'
      and monitor_name = 'Inactive API'
  ),
  0,
  'an inactive selected monitor does not leak'
);

select is(
  (
    select count(*)::int
    from public.public_status_page_monitors
    where status_page_slug = 'status-b-private'
  ),
  0,
  'an unpublished status page does not leak'
);

select is(
  (
    select count(*)::int
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_status_pages'
      and column_name in ('id', 'organization_id', 'created_by', 'is_published')
  ),
  0,
  'the public page view exposes no internal IDs or publication flags'
);

select is(
  (
    select count(*)::int
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_status_page_monitors'
      and column_name in (
        'monitor_id', 'organization_id', 'status_page_id', 'url'
      )
  ),
  0,
  'the public monitor view exposes no internal IDs or URLs'
);

select throws_ok(
  'select * from public.status_pages',
  '42501',
  null,
  'anon cannot read the status_pages base table'
);

select throws_ok(
  'select * from public.status_page_monitors',
  '42501',
  null,
  'anon cannot read the status_page_monitors base table'
);

select throws_ok(
  'select * from public.monitors',
  '42501',
  null,
  'anon cannot read monitors through the base table'
);

-- ============================================================
-- Authenticated other tenant
-- ============================================================
reset role;
set local request.jwt.claims = '{"sub":"42222222-2222-4222-8222-222222222222","role":"authenticated"}';
set local role authenticated;

select is(
  (
    select count(*)::int
    from public.public_status_pages
    where slug = 'status-a-public'
  ),
  1,
  'authenticated users see the same published public data'
);

select is(
  (select count(*)::int from public.monitors),
  1,
  'the other tenant cannot read the first tenant monitors'
);

-- ============================================================
-- Publication and activation toggles
-- ============================================================
reset role;

update public.status_pages
set is_published = false
where slug = 'status-a-public';

set local role anon;

select is(
  (
    select count(*)::int
    from public.public_status_pages
    where slug = 'status-a-public'
  ),
  0,
  'unpublishing removes the page from the public view'
);

select is(
  (
    select count(*)::int
    from public.public_status_page_monitors
    where status_page_slug = 'status-a-public'
  ),
  0,
  'unpublishing removes the selected monitors from the public view'
);

reset role;

update public.status_pages
set is_published = true
where slug = 'status-a-public';

update public.monitors
set is_active = false
where id = '4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role anon;

select is(
  (
    select count(*)::int
    from public.public_status_pages
    where slug = 'status-a-public'
  ),
  1,
  'the page is visible again when republished'
);

select is(
  (
    select count(*)::int
    from public.public_status_page_monitors
    where status_page_slug = 'status-a-public'
  ),
  0,
  'deactivating the monitor hides it even on a published page'
);

select * from finish();
rollback;
