-- ============================================================
-- Remove non-DML default privileges from public API roles
-- ============================================================
-- Supabase's local defaults grant anon/authenticated TRUNCATE, REFERENCES,
-- TRIGGER, and (on PostgreSQL 17+) MAINTAIN on newly created tables. TRUNCATE
-- is not filtered by RLS, so those default grants must not remain on private
-- tables. DML privileges are granted explicitly by the earlier migrations.
-- ============================================================

revoke truncate, references, trigger on all tables in schema public
  from anon, authenticated;

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute
      'revoke maintain on all tables in schema public from anon, authenticated';
  end if;
end $$;

revoke all on all sequences in schema public from anon, authenticated;

-- Prevent future objects created by the migration role from regaining the
-- same non-DML privileges. Supabase's auto_expose_new_tables setting only
-- controls DML grants; it does not remove these defaults.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute
      'alter default privileges for role postgres in schema public revoke maintain on tables from anon, authenticated';
  end if;
end $$;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
