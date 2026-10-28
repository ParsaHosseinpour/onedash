-- ============================================================
-- Local development seed data
-- ============================================================
-- Loaded by `supabase db reset`. Never run this against a production project.
--
-- Local-only accounts (password: onedash-dev-password1):
--   owner@acme.test    owner  of Acme Monitoring
--   admin@acme.test    admin  of Acme Monitoring
--   member@acme.test   member of Acme Monitoring
--   viewer@acme.test   viewer of Acme Monitoring
--   owner@globex.test  owner  of Globex Status
--   admin@globex.test  admin  of Globex Status
--
-- The auth.users insert fires the account-bootstrap trigger, which creates a
-- profile and a personal organization for each user. The seed then renames the
-- two owner organizations and adds the remaining memberships.
-- ============================================================

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'owner@acme.test',
    extensions.crypt('onedash-dev-password1', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Acme Owner"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'admin@acme.test',
    extensions.crypt('onedash-dev-password1', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Acme Admin"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '33333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'member@acme.test',
    extensions.crypt('onedash-dev-password1', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Acme Member"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '44444444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'viewer@acme.test',
    extensions.crypt('onedash-dev-password1', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Acme Viewer"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '55555555-5555-4555-8555-555555555555',
    'authenticated',
    'authenticated',
    'owner@globex.test',
    extensions.crypt('onedash-dev-password1', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Globex Owner"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '66666666-6666-4666-8666-666666666666',
    'authenticated',
    'authenticated',
    'admin@globex.test',
    extensions.crypt('onedash-dev-password1', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Globex Admin"}'::jsonb,
    now(),
    now()
  )
on conflict (id) do nothing;

insert into auth.identities (
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
select
  u.id::text,
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(),
  now(),
  now()
from auth.users u
where u.email in (
  'owner@acme.test',
  'admin@acme.test',
  'member@acme.test',
  'viewer@acme.test',
  'owner@globex.test',
  'admin@globex.test'
)
on conflict (provider_id, provider) do nothing;

-- Rename the two personal organizations created by the bootstrap trigger.
update public.organizations o
set name = 'Acme Monitoring',
    slug = 'acme-monitoring'
where o.id = (
  select m.organization_id
  from public.organization_members m
  where m.user_id = '11111111-1111-4111-8111-111111111111'
    and m.role = 'owner'
  order by m.created_at, m.id
  limit 1
);

update public.organizations o
set name = 'Globex Status',
    slug = 'globex-status'
where o.id = (
  select m.organization_id
  from public.organization_members m
  where m.user_id = '55555555-5555-4555-8555-555555555555'
    and m.role = 'owner'
  order by m.created_at, m.id
  limit 1
);

insert into public.organization_members (organization_id, user_id, role)
select o.id, '22222222-2222-4222-8222-222222222222', 'admin'
from public.organizations o where o.slug = 'acme-monitoring'
on conflict (organization_id, user_id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select o.id, '33333333-3333-4333-8333-333333333333', 'member'
from public.organizations o where o.slug = 'acme-monitoring'
on conflict (organization_id, user_id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select o.id, '44444444-4444-4444-8444-444444444444', 'viewer'
from public.organizations o where o.slug = 'acme-monitoring'
on conflict (organization_id, user_id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select o.id, '66666666-6666-4666-8666-666666666666', 'admin'
from public.organizations o where o.slug = 'globex-status'
on conflict (organization_id, user_id) do nothing;

-- ------------------------------------------------------------
-- Monitors and schedules
-- ------------------------------------------------------------

insert into public.monitors (
  id, organization_id, created_by, name, url, method,
  expected_status_codes, interval_seconds, timeout_seconds, is_active
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'acme-monitoring'),
    '11111111-1111-4111-8111-111111111111',
    'Acme API',
    'https://api.acme.test/health',
    'GET',
    array[200],
    300,
    10,
    true
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'acme-monitoring'),
    '11111111-1111-4111-8111-111111111111',
    'Acme private admin',
    'https://admin.acme.test/health',
    'GET',
    array[200],
    300,
    10,
    true
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select id from public.organizations where slug = 'globex-status'),
    '55555555-5555-4555-8555-555555555555',
    'Globex API',
    'https://api.globex.test/health',
    'HEAD',
    array[200, 204],
    600,
    15,
    true
  )
on conflict (id) do nothing;

insert into public.monitor_schedules (
  organization_id, monitor_id, region, next_run_at
)
values
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'us-east',
    now() + interval '1 minute'
  ),
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'eu-west',
    now() + interval '2 minutes'
  ),
  (
    (select id from public.organizations where slug = 'globex-status'),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'us-east',
    now() + interval '3 minutes'
  )
on conflict (monitor_id, region) do nothing;

-- ------------------------------------------------------------
-- State, results, and incidents
-- ------------------------------------------------------------

insert into public.check_results (
  organization_id, monitor_id, region, status, http_status,
  response_time_ms, total_ms, error_class, error_message,
  checked_at, idempotency_key
)
values
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'us-east', 'up', 200, 120, 140, null, null,
    now() - interval '5 minutes',
    'seed-acme-api-us-east-1'
  ),
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'eu-west', 'up', 200, 180, 210, null, null,
    now() - interval '4 minutes',
    'seed-acme-api-eu-west-1'
  ),
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'us-east', 'down', 503, 90, 95,
    'http_status_mismatch', 'Expected 200, received 503',
    now() - interval '3 minutes',
    'seed-acme-private-us-east-1'
  ),
  (
    (select id from public.organizations where slug = 'globex-status'),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'us-east', 'up', 204, 75, 80, null, null,
    now() - interval '2 minutes',
    'seed-globex-api-us-east-1'
  )
on conflict (monitor_id, idempotency_key) do nothing;

insert into public.incidents (
  id, organization_id, monitor_id, status, title, summary,
  started_at, resolved_at
)
values
  (
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    (select id from public.organizations where slug = 'acme-monitoring'),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'investigating',
    'Acme private admin is returning 503',
    'The seeded monitor is down for local development and RLS tests.',
    now() - interval '3 minutes',
    null
  ),
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    (select id from public.organizations where slug = 'acme-monitoring'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'resolved',
    'Acme API latency recovered',
    'Historical resolved incident used by the seed data.',
    now() - interval '2 days',
    now() - interval '2 days' + interval '20 minutes'
  )
on conflict (id) do nothing;

insert into public.incident_updates (
  organization_id, incident_id, author_user_id, update_type, message, created_at
)
values
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    null,
    'system',
    'Monitor failed the configured HTTP status assertion.',
    now() - interval '3 minutes'
  ),
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '11111111-1111-4111-8111-111111111111',
    'status_change',
    'Latency returned to normal.',
    now() - interval '2 days' + interval '20 minutes'
  );

insert into public.monitor_state (
  monitor_id, organization_id, status, consecutive_failures,
  consecutive_successes, last_checked_at, last_status_change_at,
  open_incident_id
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.organizations where slug = 'acme-monitoring'),
    'up', 0, 2, now() - interval '4 minutes', now() - interval '4 minutes', null
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    (select id from public.organizations where slug = 'acme-monitoring'),
    'down', 3, 0, now() - interval '3 minutes', now() - interval '3 minutes',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select id from public.organizations where slug = 'globex-status'),
    'up', 0, 1, now() - interval '2 minutes', now() - interval '2 minutes', null
  )
on conflict (monitor_id) do nothing;

-- ------------------------------------------------------------
-- Alert channels and delivery outbox
-- ------------------------------------------------------------

insert into public.alert_channels (
  id, organization_id, created_by, name, kind, config, is_enabled
)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    (select id from public.organizations where slug = 'acme-monitoring'),
    '11111111-1111-4111-8111-111111111111',
    'Acme ops email',
    'email',
    '{"address":"ops@acme.test"}'::jsonb,
    true
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    (select id from public.organizations where slug = 'acme-monitoring'),
    '11111111-1111-4111-8111-111111111111',
    'Acme webhook',
    'webhook',
    '{"host":"hooks.example.test"}'::jsonb,
    true
  ),
  (
    'a3333333-3333-4333-8333-333333333333',
    (select id from public.organizations where slug = 'globex-status'),
    '55555555-5555-4555-8555-555555555555',
    'Globex ops email',
    'email',
    '{"address":"ops@globex.test"}'::jsonb,
    true
  )
on conflict (id) do nothing;

insert into public.alert_channel_secrets (
  channel_id, organization_id, ciphertext, encryption_key_id
)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    (select id from public.organizations where slug = 'acme-monitoring'),
    decode('c0ffee', 'hex'),
    'local-dev-placeholder'
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    (select id from public.organizations where slug = 'acme-monitoring'),
    decode('c0ffee', 'hex'),
    'local-dev-placeholder'
  ),
  (
    'a3333333-3333-4333-8333-333333333333',
    (select id from public.organizations where slug = 'globex-status'),
    decode('c0ffee', 'hex'),
    'local-dev-placeholder'
  )
on conflict (channel_id) do nothing;

insert into public.monitor_alert_channels (
  organization_id, monitor_id, alert_channel_id
)
values
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'a1111111-1111-4111-8111-111111111111'
  ),
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'a2222222-2222-4222-8222-222222222222'
  ),
  (
    (select id from public.organizations where slug = 'globex-status'),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'a3333333-3333-4333-8333-333333333333'
  )
on conflict (monitor_id, alert_channel_id) do nothing;

insert into public.alert_deliveries (
  organization_id, incident_id, monitor_id, alert_channel_id,
  dedupe_key, status, attempts, next_attempt_at
)
values
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'a2222222-2222-4222-8222-222222222222',
    'seed:incident:dddddddd:webhook:opened',
    'queued',
    0,
    now()
  )
on conflict (dedupe_key) do nothing;

-- ------------------------------------------------------------
-- Status pages
-- ------------------------------------------------------------

insert into public.status_pages (
  id, organization_id, created_by, slug, name, description,
  branding, is_published
)
values
  (
    'f1111111-1111-4111-8111-111111111111',
    (select id from public.organizations where slug = 'acme-monitoring'),
    '11111111-1111-4111-8111-111111111111',
    'acme-status',
    'Acme Status',
    'Live status for Acme services.',
    '{"accent":"#2563eb"}'::jsonb,
    true
  ),
  (
    'f2222222-2222-4222-8222-222222222222',
    (select id from public.organizations where slug = 'globex-status'),
    '55555555-5555-4555-8555-555555555555',
    'globex-status',
    'Globex Status',
    'Unpublished local status page.',
    '{}'::jsonb,
    false
  )
on conflict (id) do nothing;

insert into public.status_page_monitors (
  organization_id, status_page_id, monitor_id, display_name, sort_order
)
values
  (
    (select id from public.organizations where slug = 'acme-monitoring'),
    'f1111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Public API',
    0
  ),
  (
    (select id from public.organizations where slug = 'globex-status'),
    'f2222222-2222-4222-8222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'Globex API',
    0
  )
on conflict (status_page_id, monitor_id) do nothing;
