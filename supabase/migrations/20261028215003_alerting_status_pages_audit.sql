-- ============================================================
-- Alerting, public status pages, and audit logs
-- ============================================================
-- Secrets are split from configuration:
--   * alert_channels.config is non-secret routing metadata and is not
--     selectable by anon/authenticated.
--   * alert_channel_secrets stores ciphertext only and is readable solely by
--     the worker role/service role.
--   * branding is public by definition and is checked for obvious secret keys.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'alert_channel_type') then
    create type public.alert_channel_type as enum (
      'email', 'webhook', 'discord', 'telegram'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'alert_delivery_status') then
    create type public.alert_delivery_status as enum (
      'queued', 'sending', 'delivered', 'failed', 'dead_letter', 'cancelled'
    );
  end if;
end $$;

-- ------------------------------------------------------------
-- Alert channels
-- ------------------------------------------------------------

create table public.alert_channels (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  created_by       uuid references auth.users (id) on delete set null,
  name             text not null,
  kind             public.alert_channel_type not null,
  config           jsonb not null default '{}'::jsonb,
  is_enabled       boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint alert_channels_id_organization_key unique (id, organization_id),
  constraint alert_channels_name_check check (char_length(name) between 1 and 120),
  constraint alert_channels_config_check check (
    jsonb_typeof(config) = 'object'
    and pg_column_size(config) <= 8192
    and not (
      config ?| array[
        'token', 'secret', 'password', 'authorization', 'api_key', 'webhook_url'
      ]
    )
  )
);

create index alert_channels_org_idx
  on public.alert_channels (organization_id);

alter table public.alert_channels enable row level security;

create policy "members can read alert channel metadata"
  on public.alert_channels
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners and admins can create alert channels"
  on public.alert_channels
  for insert
  to authenticated
  with check (
    public.can_manage_org(organization_id)
    and created_by = auth.uid()
  );

create policy "owners and admins can update alert channels"
  on public.alert_channels
  for update
  to authenticated
  using (public.can_manage_org(organization_id))
  with check (public.can_manage_org(organization_id));

create policy "owners and admins can delete alert channels"
  on public.alert_channels
  for delete
  to authenticated
  using (public.can_manage_org(organization_id));

create policy "worker can read alert channels"
  on public.alert_channels
  for select
  to onedash_worker
  using (true);

drop trigger if exists alert_channels_set_updated_at on public.alert_channels;
create trigger alert_channels_set_updated_at
  before update on public.alert_channels
  for each row execute function public.set_updated_at();

drop trigger if exists alert_channels_prevent_tenant_change on public.alert_channels;
create trigger alert_channels_prevent_tenant_change
  before update on public.alert_channels
  for each row execute function public.prevent_tenant_id_change();

drop trigger if exists alert_channels_prevent_created_by_change on public.alert_channels;
create trigger alert_channels_prevent_created_by_change
  before update on public.alert_channels
  for each row execute function public.prevent_created_by_change();

create table public.alert_channel_secrets (
  channel_id        uuid primary key,
  organization_id   uuid not null,
  ciphertext        bytea not null,
  encryption_key_id text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint alert_channel_secrets_channel_fk
    foreign key (channel_id, organization_id)
    references public.alert_channels (id, organization_id)
    on delete cascade,
  constraint alert_channel_secrets_ciphertext_check check (
    octet_length(ciphertext) between 1 and 65536
  ),
  constraint alert_channel_secrets_key_id_check check (
    char_length(encryption_key_id) between 1 and 100
  )
);

alter table public.alert_channel_secrets enable row level security;

create policy "worker can read alert channel secrets"
  on public.alert_channel_secrets
  for select
  to onedash_worker
  using (true);

drop trigger if exists alert_channel_secrets_set_updated_at on public.alert_channel_secrets;
create trigger alert_channel_secrets_set_updated_at
  before update on public.alert_channel_secrets
  for each row execute function public.set_updated_at();

drop trigger if exists alert_channel_secrets_prevent_tenant_change on public.alert_channel_secrets;
create trigger alert_channel_secrets_prevent_tenant_change
  before update on public.alert_channel_secrets
  for each row execute function public.prevent_tenant_id_change();

comment on table public.alert_channel_secrets is
  'Encrypted alert credentials. No anon/authenticated policies or grants; only the worker role can read.';

-- ------------------------------------------------------------
-- Monitor-to-channel links
-- ------------------------------------------------------------

create table public.monitor_alert_channels (
  organization_id   uuid not null,
  monitor_id        uuid not null,
  alert_channel_id  uuid not null,
  created_at        timestamptz not null default now(),
  constraint monitor_alert_channels_pkey primary key (monitor_id, alert_channel_id),
  constraint monitor_alert_channels_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint monitor_alert_channels_channel_fk
    foreign key (alert_channel_id, organization_id)
    references public.alert_channels (id, organization_id)
    on delete cascade
);

create index monitor_alert_channels_channel_idx
  on public.monitor_alert_channels (alert_channel_id);

create index monitor_alert_channels_org_idx
  on public.monitor_alert_channels (organization_id);

alter table public.monitor_alert_channels enable row level security;

create policy "members can read monitor alert links"
  on public.monitor_alert_channels
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners and admins can link alert channels"
  on public.monitor_alert_channels
  for insert
  to authenticated
  with check (public.can_manage_org(organization_id));

create policy "owners and admins can unlink alert channels"
  on public.monitor_alert_channels
  for delete
  to authenticated
  using (public.can_manage_org(organization_id));

create policy "worker can read monitor alert links"
  on public.monitor_alert_channels
  for select
  to onedash_worker
  using (true);

-- ------------------------------------------------------------
-- Alert delivery outbox
-- ------------------------------------------------------------

create table public.alert_deliveries (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  incident_id       uuid not null,
  monitor_id        uuid not null,
  alert_channel_id  uuid not null,
  dedupe_key        text not null,
  status            public.alert_delivery_status not null default 'queued',
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_attempt_at   timestamptz,
  delivered_at      timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint alert_deliveries_incident_fk
    foreign key (incident_id, monitor_id, organization_id)
    references public.incidents (id, monitor_id, organization_id)
    on delete cascade,
  constraint alert_deliveries_channel_fk
    foreign key (alert_channel_id, organization_id)
    references public.alert_channels (id, organization_id)
    on delete cascade,
  constraint alert_deliveries_dedupe_key unique (dedupe_key),
  constraint alert_deliveries_attempts_check check (attempts between 0 and 50),
  constraint alert_deliveries_error_check check (
    last_error is null or char_length(last_error) <= 1000
  ),
  constraint alert_deliveries_delivered_check check (
    (status = 'delivered') = (delivered_at is not null)
  ),
  constraint alert_deliveries_delivered_error_check check (
    status <> 'delivered' or last_error is null
  )
);

create index alert_deliveries_pending_idx
  on public.alert_deliveries (next_attempt_at)
  where status in ('queued', 'failed');

create index alert_deliveries_org_created_idx
  on public.alert_deliveries (organization_id, created_at desc);

create index alert_deliveries_incident_idx
  on public.alert_deliveries (incident_id);

alter table public.alert_deliveries enable row level security;

create policy "owners and admins can read alert deliveries"
  on public.alert_deliveries
  for select
  to authenticated
  using (public.can_manage_org(organization_id));

create policy "worker can read alert deliveries"
  on public.alert_deliveries
  for select
  to onedash_worker
  using (true);

create policy "worker can create alert deliveries"
  on public.alert_deliveries
  for insert
  to onedash_worker
  with check (true);

create policy "worker can update alert deliveries"
  on public.alert_deliveries
  for update
  to onedash_worker
  using (true)
  with check (true);

drop trigger if exists alert_deliveries_set_updated_at on public.alert_deliveries;
create trigger alert_deliveries_set_updated_at
  before update on public.alert_deliveries
  for each row execute function public.set_updated_at();

drop trigger if exists alert_deliveries_prevent_tenant_change on public.alert_deliveries;
create trigger alert_deliveries_prevent_tenant_change
  before update on public.alert_deliveries
  for each row execute function public.prevent_tenant_id_change();

drop trigger if exists alert_deliveries_prevent_monitor_change on public.alert_deliveries;
create trigger alert_deliveries_prevent_monitor_change
  before update on public.alert_deliveries
  for each row execute function public.prevent_monitor_id_change();

-- ------------------------------------------------------------
-- Public status pages
-- ------------------------------------------------------------

create table public.status_pages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  created_by       uuid references auth.users (id) on delete set null,
  slug             text not null,
  name             text not null,
  description      text,
  branding         jsonb not null default '{}'::jsonb,
  is_published     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint status_pages_slug_key unique (slug),
  constraint status_pages_id_organization_key unique (id, organization_id),
  constraint status_pages_slug_check check (
    char_length(slug) between 3 and 64
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint status_pages_name_check check (char_length(name) between 1 and 120),
  constraint status_pages_description_check check (
    description is null or char_length(description) <= 500
  ),
  constraint status_pages_branding_check check (
    jsonb_typeof(branding) = 'object'
    and pg_column_size(branding) <= 8192
    and not (
      branding ?| array[
        'token', 'secret', 'password', 'authorization', 'api_key'
      ]
    )
  )
);

create index status_pages_org_idx
  on public.status_pages (organization_id);

alter table public.status_pages enable row level security;

create policy "members can read status pages"
  on public.status_pages
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners and admins can create status pages"
  on public.status_pages
  for insert
  to authenticated
  with check (
    public.can_manage_org(organization_id)
    and created_by = auth.uid()
  );

create policy "owners and admins can update status pages"
  on public.status_pages
  for update
  to authenticated
  using (public.can_manage_org(organization_id))
  with check (public.can_manage_org(organization_id));

create policy "owners and admins can delete status pages"
  on public.status_pages
  for delete
  to authenticated
  using (public.can_manage_org(organization_id));

drop trigger if exists status_pages_set_updated_at on public.status_pages;
create trigger status_pages_set_updated_at
  before update on public.status_pages
  for each row execute function public.set_updated_at();

drop trigger if exists status_pages_prevent_tenant_change on public.status_pages;
create trigger status_pages_prevent_tenant_change
  before update on public.status_pages
  for each row execute function public.prevent_tenant_id_change();

drop trigger if exists status_pages_prevent_created_by_change on public.status_pages;
create trigger status_pages_prevent_created_by_change
  before update on public.status_pages
  for each row execute function public.prevent_created_by_change();

create table public.status_page_monitors (
  organization_id  uuid not null,
  status_page_id   uuid not null,
  monitor_id       uuid not null,
  display_name     text,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  constraint status_page_monitors_pkey primary key (status_page_id, monitor_id),
  constraint status_page_monitors_page_fk
    foreign key (status_page_id, organization_id)
    references public.status_pages (id, organization_id)
    on delete cascade,
  constraint status_page_monitors_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint status_page_monitors_display_name_check check (
    display_name is null or char_length(display_name) between 1 and 120
  ),
  constraint status_page_monitors_sort_order_check check (
    sort_order between -1000 and 1000
  )
);

create index status_page_monitors_page_order_idx
  on public.status_page_monitors (status_page_id, sort_order);

create index status_page_monitors_monitor_idx
  on public.status_page_monitors (monitor_id);

alter table public.status_page_monitors enable row level security;

create policy "members can read status page monitors"
  on public.status_page_monitors
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners and admins can add status page monitors"
  on public.status_page_monitors
  for insert
  to authenticated
  with check (public.can_manage_org(organization_id));

create policy "owners and admins can update status page monitors"
  on public.status_page_monitors
  for update
  to authenticated
  using (public.can_manage_org(organization_id))
  with check (public.can_manage_org(organization_id));

create policy "owners and admins can remove status page monitors"
  on public.status_page_monitors
  for delete
  to authenticated
  using (public.can_manage_org(organization_id));

drop trigger if exists status_page_monitors_prevent_tenant_change on public.status_page_monitors;
create trigger status_page_monitors_prevent_tenant_change
  before update on public.status_page_monitors
  for each row execute function public.prevent_tenant_id_change();

drop trigger if exists status_page_monitors_prevent_monitor_change on public.status_page_monitors;
create trigger status_page_monitors_prevent_monitor_change
  before update on public.status_page_monitors
  for each row execute function public.prevent_monitor_id_change();

-- ------------------------------------------------------------
-- Narrow public views
-- ------------------------------------------------------------
-- These are security-definer views owned by postgres. They intentionally
-- bypass RLS and apply explicit filters; do not add internal IDs, URLs,
-- organization IDs, emails, or secrets to their select lists.
-- ------------------------------------------------------------

create view public.public_status_pages
with (security_invoker = false)
as
select
  sp.slug,
  sp.name,
  sp.description,
  sp.branding,
  sp.updated_at
from public.status_pages sp
where sp.is_published = true;

create view public.public_status_page_monitors
with (security_invoker = false)
as
select
  sp.slug as status_page_slug,
  coalesce(spm.display_name, m.name) as monitor_name,
  ms.status as monitor_status,
  ms.last_checked_at
from public.status_page_monitors spm
join public.status_pages sp
  on sp.id = spm.status_page_id
 and sp.organization_id = spm.organization_id
join public.monitors m
  on m.id = spm.monitor_id
 and m.organization_id = spm.organization_id
left join public.monitor_state ms
  on ms.monitor_id = m.id
where sp.is_published = true
  and m.is_active = true
order by spm.sort_order, monitor_name;

comment on view public.public_status_pages is
  'Published status-page public fields only. No internal IDs, organization IDs, or private flags.';

comment on view public.public_status_page_monitors is
  'Published, active, explicitly selected monitors only. No URLs, internal IDs, organization IDs, or private monitor metadata.';

-- ------------------------------------------------------------
-- Audit logs
-- ------------------------------------------------------------

create table public.audit_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  actor_user_id    uuid references auth.users (id) on delete set null,
  action           text not null,
  entity_type      text not null,
  entity_id        uuid,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  constraint audit_logs_action_check check (char_length(action) between 1 and 64),
  constraint audit_logs_entity_type_check check (
    char_length(entity_type) between 1 and 64
  ),
  constraint audit_logs_metadata_check check (
    jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 8192
    and not (
      metadata ?| array[
        'token', 'secret', 'password', 'authorization', 'api_key', 'ciphertext'
      ]
    )
  )
);

create index audit_logs_org_created_idx
  on public.audit_logs (organization_id, created_at desc);

create index audit_logs_entity_idx
  on public.audit_logs (entity_type, entity_id);

alter table public.audit_logs enable row level security;

create policy "owners and admins can read audit logs"
  on public.audit_logs
  for select
  to authenticated
  using (public.can_manage_org(organization_id));

create or replace function public.audit_configuration_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb;
  v_old jsonb;
  v_organization_id uuid;
  v_entity_id uuid;
  v_actor_user_id uuid := auth.uid();
begin
  v_new := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old := case when tg_op = 'INSERT' then null else to_jsonb(old) end;

  v_organization_id := coalesce(
    (v_new ->> 'organization_id')::uuid,
    (v_old ->> 'organization_id')::uuid,
    (v_new ->> 'id')::uuid,
    (v_old ->> 'id')::uuid
  );

  -- An organization deletion cascades through child tables. Do not attempt to
  -- write a tenant-scoped audit row after the tenant has gone.
  if v_organization_id is null or not exists (
    select 1 from public.organizations o where o.id = v_organization_id
  ) then
    return coalesce(new, old);
  end if;

  v_entity_id := coalesce(
    (v_new ->> 'id')::uuid,
    (v_old ->> 'id')::uuid,
    (v_new ->> 'monitor_id')::uuid,
    (v_old ->> 'monitor_id')::uuid,
    (v_new ->> 'status_page_id')::uuid,
    (v_old ->> 'status_page_id')::uuid,
    (v_new ->> 'channel_id')::uuid,
    (v_old ->> 'channel_id')::uuid
  );

  insert into public.audit_logs (
    organization_id,
    actor_user_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  values (
    v_organization_id,
    v_actor_user_id,
    lower(tg_op),
    tg_table_name,
    v_entity_id,
    jsonb_build_object('operation', tg_op)
  );

  return coalesce(new, old);
end;
$$;

revoke all on function public.audit_configuration_change() from public;

drop trigger if exists organizations_audit_update on public.organizations;
create trigger organizations_audit_update
  after update on public.organizations
  for each row execute function public.audit_configuration_change();

drop trigger if exists organization_members_audit_insert on public.organization_members;
create trigger organization_members_audit_insert
  after insert on public.organization_members
  for each row execute function public.audit_configuration_change();

drop trigger if exists organization_members_audit_update on public.organization_members;
create trigger organization_members_audit_update
  after update on public.organization_members
  for each row execute function public.audit_configuration_change();

drop trigger if exists organization_members_audit_delete on public.organization_members;
create trigger organization_members_audit_delete
  after delete on public.organization_members
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitors_audit_insert on public.monitors;
create trigger monitors_audit_insert
  after insert on public.monitors
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitors_audit_update on public.monitors;
create trigger monitors_audit_update
  after update on public.monitors
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitors_audit_delete on public.monitors;
create trigger monitors_audit_delete
  after delete on public.monitors
  for each row execute function public.audit_configuration_change();

drop trigger if exists alert_channels_audit_insert on public.alert_channels;
create trigger alert_channels_audit_insert
  after insert on public.alert_channels
  for each row execute function public.audit_configuration_change();

drop trigger if exists alert_channels_audit_update on public.alert_channels;
create trigger alert_channels_audit_update
  after update on public.alert_channels
  for each row execute function public.audit_configuration_change();

drop trigger if exists alert_channels_audit_delete on public.alert_channels;
create trigger alert_channels_audit_delete
  after delete on public.alert_channels
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitor_alert_channels_audit_insert on public.monitor_alert_channels;
create trigger monitor_alert_channels_audit_insert
  after insert on public.monitor_alert_channels
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitor_alert_channels_audit_delete on public.monitor_alert_channels;
create trigger monitor_alert_channels_audit_delete
  after delete on public.monitor_alert_channels
  for each row execute function public.audit_configuration_change();

drop trigger if exists status_pages_audit_insert on public.status_pages;
create trigger status_pages_audit_insert
  after insert on public.status_pages
  for each row execute function public.audit_configuration_change();

drop trigger if exists status_pages_audit_update on public.status_pages;
create trigger status_pages_audit_update
  after update on public.status_pages
  for each row execute function public.audit_configuration_change();

drop trigger if exists status_pages_audit_delete on public.status_pages;
create trigger status_pages_audit_delete
  after delete on public.status_pages
  for each row execute function public.audit_configuration_change();

drop trigger if exists status_page_monitors_audit_insert on public.status_page_monitors;
create trigger status_page_monitors_audit_insert
  after insert on public.status_page_monitors
  for each row execute function public.audit_configuration_change();

drop trigger if exists status_page_monitors_audit_delete on public.status_page_monitors;
create trigger status_page_monitors_audit_delete
  after delete on public.status_page_monitors
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitor_request_secrets_audit_insert on public.monitor_request_secrets;
create trigger monitor_request_secrets_audit_insert
  after insert on public.monitor_request_secrets
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitor_request_secrets_audit_update on public.monitor_request_secrets;
create trigger monitor_request_secrets_audit_update
  after update on public.monitor_request_secrets
  for each row execute function public.audit_configuration_change();

drop trigger if exists monitor_request_secrets_audit_delete on public.monitor_request_secrets;
create trigger monitor_request_secrets_audit_delete
  after delete on public.monitor_request_secrets
  for each row execute function public.audit_configuration_change();

drop trigger if exists alert_channel_secrets_audit_insert on public.alert_channel_secrets;
create trigger alert_channel_secrets_audit_insert
  after insert on public.alert_channel_secrets
  for each row execute function public.audit_configuration_change();

drop trigger if exists alert_channel_secrets_audit_update on public.alert_channel_secrets;
create trigger alert_channel_secrets_audit_update
  after update on public.alert_channel_secrets
  for each row execute function public.audit_configuration_change();

drop trigger if exists alert_channel_secrets_audit_delete on public.alert_channel_secrets;
create trigger alert_channel_secrets_audit_delete
  after delete on public.alert_channel_secrets
  for each row execute function public.audit_configuration_change();

-- ------------------------------------------------------------
-- Grants
-- ------------------------------------------------------------

grant select on public.public_status_pages to anon, authenticated;
grant select on public.public_status_page_monitors to anon, authenticated;

grant select (id, organization_id, name, kind, is_enabled, created_at, updated_at)
  on public.alert_channels to authenticated;
grant insert (organization_id, created_by, name, kind, config, is_enabled)
  on public.alert_channels to authenticated;
grant update (name, kind, config, is_enabled)
  on public.alert_channels to authenticated;
grant delete on public.alert_channels to authenticated;

grant select, insert, delete on public.monitor_alert_channels to authenticated;
grant select on public.alert_deliveries to authenticated;

grant select, insert, update, delete on public.status_pages to authenticated;
grant select, insert, update, delete on public.status_page_monitors to authenticated;
grant select on public.audit_logs to authenticated;

-- Worker access. The worker role is NOLOGIN; production must create a login
-- role that is a member of it or use a dedicated least-privilege connection.
grant select on public.alert_channels to onedash_worker;
grant select on public.alert_channel_secrets to onedash_worker;
grant select on public.monitor_alert_channels to onedash_worker;
grant select, insert, update on public.alert_deliveries to onedash_worker;
