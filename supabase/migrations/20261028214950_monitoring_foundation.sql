-- ============================================================
-- Monitoring foundation: monitors, schedules, state, results, incidents
-- ============================================================
-- No scheduler or checker is implemented in Phase 2. These tables define the
-- contract that the Phase 4 worker will use.
--
-- Deliberate design choices:
--   * check_results is append-only and has no response-body columns.
--   * monitor_request_secrets is a separate, non-readable table. Credential-
--     bearing headers/bodies are ciphertext and only the worker role can read
--     them. Normal application queries never touch this table.
--   * (monitor_id, idempotency_key) is unique, so at-least-once ingestion is
--     safe.
--   * A partial unique index permits at most one unresolved incident per
--     monitor.
--   * check_results is not partitioned yet. The retention/partition plan is
--     documented in docs/database.md; the indexes below support the planned
--     time-based maintenance queries.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'monitor_method') then
    create type public.monitor_method as enum (
      'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'monitor_status') then
    create type public.monitor_status as enum (
      'unknown', 'up', 'degraded', 'down', 'paused'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'check_status') then
    create type public.check_status as enum ('up', 'degraded', 'down', 'error');
  end if;

  if not exists (select 1 from pg_type where typname = 'incident_status') then
    create type public.incident_status as enum (
      'investigating', 'identified', 'monitoring', 'resolved'
    );
  end if;
end $$;

create or replace function public.is_valid_http_status_array(codes integer[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    cardinality(codes) between 1 and 20
    and not exists (
      select 1
      from pg_catalog.unnest(codes) as code
      where code < 100 or code > 599
    ),
    false
  );
$$;

-- ------------------------------------------------------------
-- Tenant/identity immutability helpers
-- ------------------------------------------------------------

create or replace function public.prevent_tenant_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_monitor_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) ->> 'monitor_id') is distinct from (to_jsonb(old) ->> 'monitor_id') then
    raise exception 'monitor_id is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_created_by_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'created_by is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_tenant_id_change() from public;
revoke all on function public.prevent_monitor_id_change() from public;
revoke all on function public.prevent_created_by_change() from public;

-- ------------------------------------------------------------
-- Monitors
-- ------------------------------------------------------------

create table public.monitors (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  created_by             uuid references auth.users (id) on delete set null,
  name                   text not null,
  url                    text not null,
  method                 public.monitor_method not null default 'GET',
  expected_status_codes  integer[] not null default array[200],
  expected_body_text     text,
  expected_body_is_regex boolean not null default false,
  interval_seconds       integer not null default 300,
  timeout_seconds        integer not null default 10,
  verify_tls             boolean not null default true,
  follow_redirects       boolean not null default false,
  max_redirects          integer not null default 0,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint monitors_id_organization_id_key unique (id, organization_id),
  constraint monitors_name_check check (char_length(name) between 1 and 120),
  constraint monitors_url_check check (
    char_length(url) between 8 and 2048
    and url ~* '^https?://[^[:space:]]+$'
    and url !~* '^[a-z]+://[^/]*@'
  ),
  constraint monitors_expected_status_codes_check check (
    public.is_valid_http_status_array(expected_status_codes)
  ),
  constraint monitors_expected_body_text_check check (
    expected_body_text is null or char_length(expected_body_text) <= 500
  ),
  constraint monitors_interval_check check (interval_seconds between 60 and 86400),
  constraint monitors_timeout_check check (
    timeout_seconds between 1 and 60
    and timeout_seconds < interval_seconds
  ),
  constraint monitors_redirect_check check (
    (follow_redirects and max_redirects between 1 and 10)
    or (not follow_redirects and max_redirects = 0)
  )
);

create index monitors_org_created_idx
  on public.monitors (organization_id, created_at desc);

create index monitors_active_org_idx
  on public.monitors (organization_id)
  where is_active;

alter table public.monitors enable row level security;

create policy "members can read monitors"
  on public.monitors
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners, admins, and members can create monitors"
  on public.monitors
  for insert
  to authenticated
  with check (
    public.can_write_org(organization_id)
    and created_by = auth.uid()
  );

create policy "owners, admins, and members can update monitors"
  on public.monitors
  for update
  to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));

create policy "owners, admins, and members can delete monitors"
  on public.monitors
  for delete
  to authenticated
  using (public.can_write_org(organization_id));

create policy "worker can read monitors"
  on public.monitors
  for select
  to onedash_worker
  using (true);

drop trigger if exists monitors_set_updated_at on public.monitors;
create trigger monitors_set_updated_at
  before update on public.monitors
  for each row execute function public.set_updated_at();

drop trigger if exists monitors_prevent_tenant_change on public.monitors;
create trigger monitors_prevent_tenant_change
  before update on public.monitors
  for each row execute function public.prevent_tenant_id_change();

drop trigger if exists monitors_prevent_created_by_change on public.monitors;
create trigger monitors_prevent_created_by_change
  before update on public.monitors
  for each row execute function public.prevent_created_by_change();

-- ------------------------------------------------------------
-- Monitor request secrets (never exposed to anon/authenticated)
-- ------------------------------------------------------------

create table public.monitor_request_secrets (
  monitor_id          uuid primary key,
  organization_id     uuid not null,
  headers_ciphertext  bytea,
  body_ciphertext     bytea,
  encryption_key_id   text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint monitor_request_secrets_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint monitor_request_secrets_payload_check check (
    headers_ciphertext is not null or body_ciphertext is not null
  ),
  constraint monitor_request_secrets_key_id_check check (
    char_length(encryption_key_id) between 1 and 100
  )
);

alter table public.monitor_request_secrets enable row level security;

create policy "worker can read monitor request secrets"
  on public.monitor_request_secrets
  for select
  to onedash_worker
  using (true);

drop trigger if exists monitor_request_secrets_set_updated_at on public.monitor_request_secrets;
create trigger monitor_request_secrets_set_updated_at
  before update on public.monitor_request_secrets
  for each row execute function public.set_updated_at();

drop trigger if exists monitor_request_secrets_prevent_tenant_change on public.monitor_request_secrets;
create trigger monitor_request_secrets_prevent_tenant_change
  before update on public.monitor_request_secrets
  for each row execute function public.prevent_tenant_id_change();

comment on table public.monitor_request_secrets is
  'Encrypted request headers/bodies for monitors. RLS has no anon/authenticated policy and no table grants to those roles. Only the worker role can read it.';

-- ------------------------------------------------------------
-- Schedules
-- ------------------------------------------------------------

create table public.monitor_schedules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  monitor_id       uuid not null,
  region           text not null,
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  lease_expires_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint monitor_schedules_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint monitor_schedules_monitor_region_key unique (monitor_id, region),
  constraint monitor_schedules_region_check check (
    char_length(region) between 2 and 32
    and region ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  )
);

create index monitor_schedules_due_idx
  on public.monitor_schedules (next_run_at)
  where next_run_at is not null;

create index monitor_schedules_lease_idx
  on public.monitor_schedules (lease_expires_at)
  where lease_expires_at is not null;

create index monitor_schedules_org_idx
  on public.monitor_schedules (organization_id);

alter table public.monitor_schedules enable row level security;

create policy "members can read monitor schedules"
  on public.monitor_schedules
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners, admins, and members can create monitor schedules"
  on public.monitor_schedules
  for insert
  to authenticated
  with check (public.can_write_org(organization_id));

create policy "owners, admins, and members can update monitor schedules"
  on public.monitor_schedules
  for update
  to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));

create policy "owners, admins, and members can delete monitor schedules"
  on public.monitor_schedules
  for delete
  to authenticated
  using (public.can_write_org(organization_id));

create policy "worker can read monitor schedules"
  on public.monitor_schedules
  for select
  to onedash_worker
  using (true);

create policy "worker can update monitor schedules"
  on public.monitor_schedules
  for update
  to onedash_worker
  using (true)
  with check (true);

drop trigger if exists monitor_schedules_set_updated_at on public.monitor_schedules;
create trigger monitor_schedules_set_updated_at
  before update on public.monitor_schedules
  for each row execute function public.set_updated_at();

drop trigger if exists monitor_schedules_prevent_tenant_change on public.monitor_schedules;
create trigger monitor_schedules_prevent_tenant_change
  before update on public.monitor_schedules
  for each row execute function public.prevent_tenant_id_change();

drop trigger if exists monitor_schedules_prevent_monitor_change on public.monitor_schedules;
create trigger monitor_schedules_prevent_monitor_change
  before update on public.monitor_schedules
  for each row execute function public.prevent_monitor_id_change();

-- ------------------------------------------------------------
-- Incidents
-- ------------------------------------------------------------

create table public.incidents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  monitor_id       uuid not null,
  status           public.incident_status not null default 'investigating',
  title            text not null,
  summary          text,
  started_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint incidents_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint incidents_id_monitor_org_key unique (id, monitor_id, organization_id),
  constraint incidents_id_organization_key unique (id, organization_id),
  constraint incidents_title_check check (char_length(title) between 1 and 200),
  constraint incidents_summary_check check (
    summary is null or char_length(summary) <= 2000
  ),
  constraint incidents_resolution_check check (
    (status = 'resolved') = (resolved_at is not null)
  ),
  constraint incidents_resolved_after_started_check check (
    resolved_at is null or resolved_at >= started_at
  )
);

create unique index incidents_one_open_per_monitor_idx
  on public.incidents (monitor_id)
  where resolved_at is null;

create index incidents_org_started_idx
  on public.incidents (organization_id, started_at desc);

create index incidents_monitor_started_idx
  on public.incidents (monitor_id, started_at desc);

alter table public.incidents enable row level security;

create policy "members can read incidents"
  on public.incidents
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners and admins can create incidents"
  on public.incidents
  for insert
  to authenticated
  with check (public.can_manage_org(organization_id));

create policy "owners, admins, and members can update incidents"
  on public.incidents
  for update
  to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));

create policy "owners and admins can delete incidents"
  on public.incidents
  for delete
  to authenticated
  using (public.can_manage_org(organization_id));

create policy "worker can read incidents"
  on public.incidents
  for select
  to onedash_worker
  using (true);

create policy "worker can create incidents"
  on public.incidents
  for insert
  to onedash_worker
  with check (true);

create policy "worker can update incidents"
  on public.incidents
  for update
  to onedash_worker
  using (true)
  with check (true);

drop trigger if exists incidents_set_updated_at on public.incidents;
create trigger incidents_set_updated_at
  before update on public.incidents
  for each row execute function public.set_updated_at();

drop trigger if exists incidents_prevent_tenant_change on public.incidents;
create trigger incidents_prevent_tenant_change
  before update on public.incidents
  for each row execute function public.prevent_tenant_id_change();

drop trigger if exists incidents_prevent_monitor_change on public.incidents;
create trigger incidents_prevent_monitor_change
  before update on public.incidents
  for each row execute function public.prevent_monitor_id_change();

-- ------------------------------------------------------------
-- Incident updates (append-only timeline)
-- ------------------------------------------------------------

create table public.incident_updates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  incident_id      uuid not null,
  author_user_id   uuid references auth.users (id) on delete set null,
  update_type      text not null default 'note',
  message          text not null,
  created_at       timestamptz not null default now(),
  constraint incident_updates_incident_fk
    foreign key (incident_id, organization_id)
    references public.incidents (id, organization_id)
    on delete cascade,
  constraint incident_updates_type_check check (
    update_type in ('note', 'status_change', 'system')
  ),
  constraint incident_updates_message_check check (
    char_length(message) between 1 and 2000
  )
);

create index incident_updates_incident_created_idx
  on public.incident_updates (incident_id, created_at);

create index incident_updates_org_created_idx
  on public.incident_updates (organization_id, created_at desc);

alter table public.incident_updates enable row level security;

create policy "members can read incident updates"
  on public.incident_updates
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners, admins, and members can add incident updates"
  on public.incident_updates
  for insert
  to authenticated
  with check (
    public.can_write_org(organization_id)
    and author_user_id = auth.uid()
  );

create policy "worker can read incident updates"
  on public.incident_updates
  for select
  to onedash_worker
  using (true);

create policy "worker can add incident updates"
  on public.incident_updates
  for insert
  to onedash_worker
  with check (true);

-- ------------------------------------------------------------
-- Current monitor state (system/worker-owned)
-- ------------------------------------------------------------

create table public.monitor_state (
  monitor_id              uuid primary key,
  organization_id         uuid not null,
  status                  public.monitor_status not null default 'unknown',
  consecutive_failures    integer not null default 0,
  consecutive_successes   integer not null default 0,
  last_checked_at         timestamptz,
  last_status_change_at   timestamptz,
  open_incident_id        uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint monitor_state_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint monitor_state_open_incident_fk
    foreign key (open_incident_id, monitor_id, organization_id)
    references public.incidents (id, monitor_id, organization_id)
    on delete set null (open_incident_id),
  constraint monitor_state_failures_check check (consecutive_failures >= 0),
  constraint monitor_state_successes_check check (consecutive_successes >= 0)
);

create index monitor_state_org_status_idx
  on public.monitor_state (organization_id, status);

alter table public.monitor_state enable row level security;

create policy "members can read monitor state"
  on public.monitor_state
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "worker can read monitor state"
  on public.monitor_state
  for select
  to onedash_worker
  using (true);

create policy "worker can create monitor state"
  on public.monitor_state
  for insert
  to onedash_worker
  with check (true);

create policy "worker can update monitor state"
  on public.monitor_state
  for update
  to onedash_worker
  using (true)
  with check (true);

create or replace function public.validate_monitor_state_incident()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.open_incident_id is not null then
    if not exists (
      select 1
      from public.incidents i
      where i.id = new.open_incident_id
        and i.monitor_id = new.monitor_id
        and i.organization_id = new.organization_id
        and i.resolved_at is null
    ) then
      raise exception 'open_incident_id must reference an unresolved incident for this monitor'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_monitor_state_incident() from public;

drop trigger if exists monitor_state_set_updated_at on public.monitor_state;
create trigger monitor_state_set_updated_at
  before update on public.monitor_state
  for each row execute function public.set_updated_at();

drop trigger if exists monitor_state_validate_incident on public.monitor_state;
create trigger monitor_state_validate_incident
  before insert or update on public.monitor_state
  for each row execute function public.validate_monitor_state_incident();

drop trigger if exists monitor_state_prevent_tenant_change on public.monitor_state;
create trigger monitor_state_prevent_tenant_change
  before update on public.monitor_state
  for each row execute function public.prevent_tenant_id_change();

-- ------------------------------------------------------------
-- Check results (append-only, no response bodies)
-- ------------------------------------------------------------

create table public.check_results (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  monitor_id        uuid not null,
  region            text not null,
  status            public.check_status not null,
  http_status       integer,
  response_time_ms  integer,
  dns_ms            integer,
  connect_ms        integer,
  tls_ms            integer,
  ttfb_ms           integer,
  total_ms          integer,
  error_class       text,
  error_message     text,
  checked_at        timestamptz not null default now(),
  scheduled_at      timestamptz,
  idempotency_key   text not null,
  created_at        timestamptz not null default now(),
  constraint check_results_monitor_fk
    foreign key (monitor_id, organization_id)
    references public.monitors (id, organization_id)
    on delete cascade,
  constraint check_results_monitor_idempotency_key unique (
    monitor_id, idempotency_key
  ),
  constraint check_results_region_check check (
    char_length(region) between 2 and 32
    and region ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint check_results_http_status_check check (
    http_status is null or http_status between 100 and 599
  ),
  constraint check_results_timings_check check (
    (response_time_ms is null or response_time_ms >= 0)
    and (dns_ms is null or dns_ms >= 0)
    and (connect_ms is null or connect_ms >= 0)
    and (tls_ms is null or tls_ms >= 0)
    and (ttfb_ms is null or ttfb_ms >= 0)
    and (total_ms is null or total_ms >= 0)
  ),
  constraint check_results_error_class_check check (
    error_class is null
    or error_class in (
      'dns_failure',
      'connection_refused',
      'timeout',
      'tls_error',
      'http_status_mismatch',
      'body_mismatch',
      'redirect_loop',
      'blocked_target',
      'internal_error',
      'latency_threshold'
    )
  ),
  constraint check_results_error_message_check check (
    error_message is null or char_length(error_message) <= 1000
  ),
  constraint check_results_idempotency_key_check check (
    char_length(idempotency_key) between 1 and 200
  ),
  constraint check_results_error_consistency_check check (
    (status = 'up' and error_class is null)
    or (status <> 'up' and error_class is not null)
  )
);

create index check_results_monitor_checked_idx
  on public.check_results (monitor_id, checked_at desc);

create index check_results_org_checked_idx
  on public.check_results (organization_id, checked_at desc);

create index check_results_checked_idx
  on public.check_results (checked_at);

alter table public.check_results enable row level security;

create policy "members can read check results"
  on public.check_results
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "worker can read check results"
  on public.check_results
  for select
  to onedash_worker
  using (true);

create policy "worker can insert check results"
  on public.check_results
  for insert
  to onedash_worker
  with check (true);

comment on table public.check_results is
  'Append-only check history. Response bodies are intentionally not stored. Unique (monitor_id, idempotency_key) makes at-least-once ingestion safe.';

-- ------------------------------------------------------------
-- Worker grants
-- ------------------------------------------------------------

grant usage on schema public to onedash_worker;

grant select on public.monitors to onedash_worker;
grant select, update on public.monitor_schedules to onedash_worker;
grant select, insert, update on public.incidents to onedash_worker;
grant select, insert on public.incident_updates to onedash_worker;
grant select, insert, update on public.monitor_state to onedash_worker;
grant select, insert on public.check_results to onedash_worker;
grant select on public.monitor_request_secrets to onedash_worker;

-- ------------------------------------------------------------
-- Application grants
-- ------------------------------------------------------------

grant select, insert, update, delete on public.monitors to authenticated;
grant select, insert, update, delete on public.monitor_schedules to authenticated;
grant select, insert, update, delete on public.incidents to authenticated;
grant select, insert on public.incident_updates to authenticated;
grant select on public.monitor_state to authenticated;
grant select on public.check_results to authenticated;
-- monitor_request_secrets is deliberately not granted to anon/authenticated.
