-- ============================================================
-- Identity, organizations, memberships, and account bootstrap
-- ============================================================
-- Tenant boundary: public.organizations.id
--
-- Roles:
--   owner  - full control, including membership and organization deletion
--   admin  - manage resources and non-owner members
--   member - read all tenant data, manage monitors/incidents
--   viewer - read-only
--
-- Every helper used by RLS is SECURITY DEFINER with an empty search_path and
-- fully-qualified names. Helpers read organization_members as the function
-- owner, which avoids recursive RLS policies on that table.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- Dedicated NOLOGIN group role for the future scheduler/checker/ingestor.
-- Production should create a separate LOGIN role and grant it this role; never
-- use the service-role key inside the worker's request path.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'onedash_worker') then
    create role onedash_worker nologin;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'organization_role') then
    create type public.organization_role as enum ('owner', 'admin', 'member', 'viewer');
  end if;
end $$;

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  display_name  text not null,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_email_format_check check (
    char_length(email) between 3 and 254
    and email = lower(btrim(email))
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint profiles_display_name_check check (
    char_length(display_name) between 1 and 100
  ),
  constraint profiles_avatar_url_check check (
    avatar_url is null
    or (char_length(avatar_url) <= 2048 and avatar_url ~ '^https?://')
  ),
  constraint profiles_email_key unique (email)
);

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint organizations_name_check check (char_length(name) between 1 and 120),
  constraint organizations_slug_check check (
    char_length(slug) between 3 and 64
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint organizations_slug_key unique (slug)
);

create table public.organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  role             public.organization_role not null default 'member',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint organization_members_org_user_key unique (organization_id, user_id)
);

create index organization_members_user_id_idx
  on public.organization_members (user_id);

create index organization_members_org_role_idx
  on public.organization_members (organization_id, role);

-- ------------------------------------------------------------
-- Generic updated_at trigger
-- ------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public;

-- ------------------------------------------------------------
-- RLS helpers
-- ------------------------------------------------------------

create or replace function public.is_org_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(
  target_organization_id uuid,
  allowed_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.role = any (allowed_roles)
  );
$$;

create or replace function public.can_manage_org(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_org_role(
    target_organization_id,
    array['owner', 'admin']::public.organization_role[]
  );
$$;

create or replace function public.can_write_org(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_org_role(
    target_organization_id,
    array['owner', 'admin', 'member']::public.organization_role[]
  );
$$;

create or replace function public.is_org_owner(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_org_role(
    target_organization_id,
    array['owner']::public.organization_role[]
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.has_org_role(uuid, public.organization_role[]) from public;
revoke all on function public.can_manage_org(uuid) from public;
revoke all on function public.can_write_org(uuid) from public;
revoke all on function public.is_org_owner(uuid) from public;

grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, public.organization_role[]) to authenticated;
grant execute on function public.can_manage_org(uuid) to authenticated;
grant execute on function public.can_write_org(uuid) to authenticated;
grant execute on function public.is_org_owner(uuid) to authenticated;

-- ------------------------------------------------------------
-- Account bootstrap
-- ------------------------------------------------------------
-- Safe to retry: an advisory lock serializes concurrent calls for one user,
-- profile insertion is idempotent, and a second organization is created only
-- when the user has no membership at all.
-- ------------------------------------------------------------

create or replace function public.ensure_user_account(target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_display_name text;
  v_organization_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_user_id::text, 0)
  );

  select
    lower(btrim(u.email)),
    left(
      coalesce(
        nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
        split_part(lower(btrim(u.email)), '@', 1)
      ),
      100
    )
  into v_email, v_display_name
  from auth.users u
  where u.id = target_user_id;

  if not found then
    raise exception 'User % does not exist', target_user_id
      using errcode = 'P0002';
  end if;

  if v_email is null or v_email = '' then
    raise exception 'Only email-based accounts can be initialized'
      using errcode = '23514';
  end if;

  insert into public.profiles (id, email, display_name)
  values (target_user_id, v_email, v_display_name)
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();

  select m.organization_id
  into v_organization_id
  from public.organization_members m
  where m.user_id = target_user_id
  order by m.created_at, m.id
  limit 1;

  if v_organization_id is not null then
    return v_organization_id;
  end if;

  insert into public.organizations (name, slug)
  values (
    left(coalesce(v_display_name, 'Personal') || ' workspace', 120),
    'org-' || replace(target_user_id::text, '-', '')
  )
  returning id into v_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_organization_id, target_user_id, 'owner')
  on conflict (organization_id, user_id) do nothing;

  return v_organization_id;
end;
$$;

create or replace function public.ensure_my_account()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  return public.ensure_user_account(v_user_id);
end;
$$;

revoke all on function public.ensure_user_account(uuid) from public;
revoke all on function public.ensure_my_account() from public;
grant execute on function public.ensure_my_account() to authenticated;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_user_account(new.id);
  return new;
end;
$$;

create or replace function public.handle_auth_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    perform public.ensure_user_account(new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.handle_auth_user_email_change() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_auth_user_email_change();

-- Backfill accounts for auth users that predate this migration. The helper is
-- idempotent, so this is safe if a user was partially initialized already.
do $$
declare
  auth_user record;
begin
  for auth_user in select id from auth.users loop
    perform public.ensure_user_account(auth_user.id);
  end loop;
end $$;

-- ------------------------------------------------------------
-- Membership invariants
-- ------------------------------------------------------------

create or replace function public.prevent_membership_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id then
    raise exception 'organization_id and user_id are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_last_org_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_remaining_owners integer;
begin
  if tg_op = 'DELETE' then
    if old.role <> 'owner' then
      return old;
    end if;

    v_organization_id := old.organization_id;

    -- An organization deletion cascades to memberships. Do not block the
    -- cascade once the parent row is gone.
    if not exists (
      select 1 from public.organizations o where o.id = v_organization_id
    ) then
      return old;
    end if;

    select count(*)
    into v_remaining_owners
    from public.organization_members m
    where m.organization_id = v_organization_id
      and m.role = 'owner'
      and m.id <> old.id;

    if v_remaining_owners = 0 then
      raise exception 'An organization must retain at least one owner'
        using errcode = '23514';
    end if;

    return old;
  end if;

  if old.role = 'owner' and new.role <> 'owner' then
    v_organization_id := old.organization_id;

    select count(*)
    into v_remaining_owners
    from public.organization_members m
    where m.organization_id = v_organization_id
      and m.role = 'owner'
      and m.id <> old.id;

    if v_remaining_owners = 0 then
      raise exception 'An organization must retain at least one owner'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_membership_identity_change() from public;
revoke all on function public.enforce_last_org_owner() from public;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

drop trigger if exists organization_members_set_updated_at on public.organization_members;
create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();

drop trigger if exists organization_members_prevent_identity_change on public.organization_members;
create trigger organization_members_prevent_identity_change
  before update on public.organization_members
  for each row execute function public.prevent_membership_identity_change();

drop trigger if exists organization_members_last_owner on public.organization_members;
create trigger organization_members_last_owner
  before update or delete on public.organization_members
  for each row execute function public.enforce_last_org_owner();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;

create policy "users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy "users can update their own profile"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "members can read their organization"
  on public.organizations
  for select
  to authenticated
  using (public.is_org_member(id));

create policy "owners and admins can update their organization"
  on public.organizations
  for update
  to authenticated
  using (public.can_manage_org(id))
  with check (public.can_manage_org(id));

create policy "owners can delete their organization"
  on public.organizations
  for delete
  to authenticated
  using (public.is_org_owner(id));

create policy "members can read organization memberships"
  on public.organization_members
  for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "owners and admins can add memberships"
  on public.organization_members
  for insert
  to authenticated
  with check (
    public.can_manage_org(organization_id)
    and (role <> 'owner' or public.is_org_owner(organization_id))
  );

create policy "owners and admins can update memberships"
  on public.organization_members
  for update
  to authenticated
  using (
    public.can_manage_org(organization_id)
    and (role <> 'owner' or public.is_org_owner(organization_id))
  )
  with check (
    public.can_manage_org(organization_id)
    and (role <> 'owner' or public.is_org_owner(organization_id))
  );

create policy "owners and admins can remove memberships"
  on public.organization_members
  for delete
  to authenticated
  using (
    public.can_manage_org(organization_id)
    and (role <> 'owner' or public.is_org_owner(organization_id))
  );

-- ------------------------------------------------------------
-- Safe directory view (no emails)
-- ------------------------------------------------------------

create view public.organization_directory
with (security_invoker = false)
as
select
  m.organization_id,
  m.user_id,
  p.display_name,
  p.avatar_url,
  m.role,
  m.created_at as joined_at
from public.organization_members m
join public.profiles p on p.id = m.user_id
where public.is_org_member(m.organization_id);

comment on view public.organization_directory is
  'Co-member directory. Security-definer view with an explicit membership filter; intentionally omits profile emails.';

-- ------------------------------------------------------------
-- Privileges
-- ------------------------------------------------------------

grant usage on schema public to anon, authenticated, onedash_worker;

-- Column-level grants keep profile emails out of normal application queries.
grant select (id, display_name, avatar_url, created_at, updated_at)
  on public.profiles to authenticated;
grant update (display_name, avatar_url, updated_at)
  on public.profiles to authenticated;

grant select, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select on public.organization_directory to authenticated;
