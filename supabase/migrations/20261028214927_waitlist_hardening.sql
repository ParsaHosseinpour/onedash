-- ============================================================
-- Waitlist: constraints, aggregate count, and trusted writes
-- ============================================================
-- This migration supersedes the table/security portion of
-- supabase/schema.sql. The legacy file is intentionally retained until the
-- migration workflow has been verified against a fresh local database.
--
-- Write path:
--   * anon/authenticated have NO table privileges. They cannot INSERT,
--     SELECT, UPDATE, or DELETE waitlist rows through PostgREST.
--   * the Next.js route handler uses SUPABASE_SERVICE_ROLE_KEY (server-only)
--     to insert a normalized row after validation and rate limiting.
--   * waitlist_count() remains callable by anon/authenticated and exposes
--     only an aggregate count.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.waitlist (
  id          bigint generated always as identity primary key,
  email       text not null,
  created_at  timestamp with time zone not null default now(),
  source      text not null default 'landing_page'
);

-- Refuse to silently rewrite legacy rows that cannot satisfy the constraints.
do $$
declare
  duplicate_groups integer;
  invalid_rows integer;
  invalid_sources integer;
begin
  select count(*) into duplicate_groups
  from (
    select lower(btrim(email))
    from public.waitlist
    group by 1
    having count(*) > 1
  ) duplicates;

  if duplicate_groups > 0 then
    raise exception
      'Waitlist hardening stopped: % case-insensitive duplicate email group(s) exist. Inspect with: SELECT lower(btrim(email)), count(*) FROM public.waitlist GROUP BY 1 HAVING count(*) > 1;',
      duplicate_groups;
  end if;

  select count(*) into invalid_rows
  from public.waitlist
  where email is null
     or char_length(btrim(email)) not between 3 and 254
     or btrim(email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';

  if invalid_rows > 0 then
    raise exception
      'Waitlist hardening stopped: % row(s) have invalid emails. Clean them up before applying this migration.',
      invalid_rows;
  end if;

  select count(*) into invalid_sources
  from public.waitlist
  where source is not null and source <> 'landing_page';

  if invalid_sources > 0 then
    raise exception
      'Waitlist hardening stopped: % row(s) have an unsupported source. Set them to landing_page or extend the allowlist explicitly.',
      invalid_sources;
  end if;
end $$;

update public.waitlist
set email = lower(btrim(email))
where email <> lower(btrim(email));

update public.waitlist
set created_at = now()
where created_at is null;

update public.waitlist
set source = 'landing_page'
where source is null or btrim(source) = '';

alter table public.waitlist
  alter column email set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column source set default 'landing_page',
  alter column source set not null;

alter table public.waitlist
  drop constraint if exists waitlist_email_format_check;

alter table public.waitlist
  add constraint waitlist_email_format_check check (
    char_length(email) between 3 and 254
    and email = lower(btrim(email))
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  );

alter table public.waitlist
  drop constraint if exists waitlist_source_check;

alter table public.waitlist
  add constraint waitlist_source_check check (source = 'landing_page');

create unique index if not exists waitlist_email_lower_key
  on public.waitlist (lower(email));

alter table public.waitlist
  drop constraint if exists waitlist_email_key;

-- No anon/authenticated policies are created. RLS stays enabled and the
-- table is not readable or writable through the public API roles.
alter table public.waitlist enable row level security;

drop policy if exists "Anyone can join the waitlist" on public.waitlist;
drop policy if exists "waitlist_insert_anon" on public.waitlist;

revoke all on table public.waitlist from anon, authenticated;

-- The trusted server route uses the service role. It only needs INSERT.
grant insert on table public.waitlist to service_role;

create or replace function public.waitlist_count()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select count(*) from public.waitlist;
$$;

revoke all on function public.waitlist_count() from public;
grant execute on function public.waitlist_count() to anon, authenticated;

comment on table public.waitlist is
  'OneDash waitlist. RLS: no anon/authenticated table privileges. The server-only service-role route inserts validated rows; aggregate count is exposed through waitlist_count().';

comment on function public.waitlist_count() is
  'Returns only the total waitlist count. Callable by anon/authenticated; individual rows remain unreadable.';

-- Security notes:
-- * Never add a SELECT policy for anon/authenticated. Individual emails must
--   stay private.
-- * The route's in-process rate limiter is still per-instance. The direct
--   PostgREST INSERT bypass is closed, but a shared limiter/WAF is required
--   before a multi-instance public launch.
-- * If a new source is intentionally supported, update waitlist_source_check
--   and the application allowlist together.
