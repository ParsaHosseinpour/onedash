# Supabase admin function ACL runbook (D-2)

## Purpose

Phase 4C.0.1 closes the application-owned `SECURITY DEFINER` ACL gap (finding
D-1) and reports one blocker it cannot fix from a normal migration (finding
D-2): the hosted `supabase_admin` role owns a default function ACL that grants
`EXECUTE` to `postgres`, `anon`, `authenticated`, and `service_role` in schema
`public`. A migration run by the local `postgres` role cannot change that
superuser's defaults or revoke privileges on functions owned by
`supabase_admin`.

Do not mark D-2 fixed from a local database. Complete this runbook on the
hosted project, record the output, and keep the evidence with the release.

## Why the local migration cannot fix D-2

The local verification database confirms:

```text
postgres: rolsuper = false
postgres: member of supabase_admin = false
supabase_admin: rolsuper = true
supabase_admin default ACL in public: EXECUTE to
  postgres, anon, authenticated, service_role
```

The Phase 4C.0.1 migration therefore:

- revokes direct application-role grants and re-grants only intended RPCs;
- hardens the default ACLs of `postgres` and `onedash_function_owner`;
- attempts the `supabase_admin` default-ACL change and emits a notice instead of
  failing when the migration role lacks permission.

## Preconditions

- A maintenance window and an approved change record.
- A connection as `supabase_admin` or a superuser that can `SET ROLE
  supabase_admin`.
- A current database backup or provider snapshot.
- Review of every public function owned by `supabase_admin` before revoking.
  Some hosted platform functions may be intentionally callable by API roles.

## Pre-check queries

Run as the privileged operator and save the output.

```sql
select current_user as current_user,
       r.rolsuper,
       pg_has_role(current_user, 'supabase_admin', 'member') as is_admin_member
from pg_roles r
where r.rolname = current_user;

select d.defaclrole::regrole as owner,
       d.defaclnamespace::regnamespace as schema,
       d.defaclobjtype,
       d.defaclacl
from pg_default_acl d
where d.defaclrole = 'supabase_admin'::regrole;

select p.oid::regprocedure as signature,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef,
       p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_userbyid(p.proowner) = 'supabase_admin'
order by 1;

select p.oid::regprocedure as signature,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
order by 1;
```

Expected after remediation:

- No `supabase_admin` default ACL entry grants `EXECUTE` to PUBLIC, `anon`,
  `authenticated`, or `service_role` in `public`.
- Application `SECURITY DEFINER` functions are executable only by their
  intended roles. The complete expected matrix is in
  `supabase/tests/database/011_phase4c01_audit_remediation.sql`.
- Any reviewed platform-owned function that genuinely needs API execution has
  an explicit, documented grant.

## Remediation

Run inside a transaction. Replace nothing in the function loop: it deliberately
touches only functions owned by `supabase_admin` in schema `public`, so
application functions and their explicit grants are not affected.

```sql
begin;

-- Future functions created by supabase_admin in public must not inherit the
-- permissive hosted default.
alter default privileges for role supabase_admin in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

-- Revoke existing direct/default-derived EXECUTE on supabase_admin-owned
-- functions. Review the pre-check list before executing this block.
do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and pg_get_userbyid(p.proowner) = 'supabase_admin'
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      v_function
    );
  end loop;
end
$$;

commit;
```

If a reviewed platform function must remain callable, re-grant it explicitly
after the transaction and record why:

```sql
grant execute on function public.example_platform_function(/* args */)
  to authenticated;
```

Do not use `revoke execute on all functions in schema public` as a shortcut. It
also revokes the intentional `anon`/`authenticated` grants on application RPCs
such as `waitlist_count()`, `ensure_my_account()`, and the organization RLS
helpers.

## Post-check and verification

Run the pre-check queries again. Then run the catalog test against the hosted
database through the normal release process (or execute its assertions
manually if the hosted environment does not permit pgTAP):

```bash
npx supabase test db --linked supabase/tests/database/011_phase4c01_audit_remediation.sql
```

Expected results:

- 28 assertions pass.
- The D-2 diagnostic reports the external-blocker status; it does not assert
  that the hosted default ACL is fixed.
- No unexpected direct `EXECUTE` grant exists for `anon`, `authenticated`, or
  `service_role` on an application `SECURITY DEFINER` function.

Also verify that the application still works: waitlist count, signup/login,
dashboard monitor list, and the organization RLS helper paths. If a platform
function was revoked, verify the affected Supabase feature in a staging project
first.

## Record

Record the following in the release evidence:

- hosted project reference and environment;
- operator identity and timestamp;
- output of the three pre-check queries before and after;
- output of the verification test or manual assertions;
- list of any explicitly re-granted platform functions and the justification;
- confirmation that no customer monitoring, real checker wiring, or gate change
  was performed by this runbook.

## Rollback

There is no automatic rollback: the remediation only removes grants. To restore
a specific reviewed function, re-grant `EXECUTE` to the minimum role and record
the reason. Do not restore the permissive `supabase_admin` default ACL; fix the
individual function instead.

## Scope boundary

This runbook fixes D-2 only. It does not enable customer monitoring, does not
wire `createRealChecker` into the database worker, does not change the
default-disabled execution gate, and does not replace the production
egress-isolation work required before customer activation.
