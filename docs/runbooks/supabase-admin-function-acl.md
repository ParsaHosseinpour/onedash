# Supabase admin function ACL runbook (D-2)

## Purpose and status

**D-2 remains open.** Phase 4C.0.3 hardens the default function ACLs that the
local migration role can administer, but it cannot fix the hosted
`supabase_admin` default ACL. On a hosted Supabase project the
`supabase_admin` role can own a default function ACL that grants `EXECUTE` to
`postgres`, `anon`, `authenticated`, and/or `service_role`. A migration run as
the local `postgres` role cannot alter another role's default privileges when
`postgres` is not a superuser and is not a member of `supabase_admin`.

This runbook is the privileged, hosted-only remediation path. It:

1. records both the global and `public`-schema `supabase_admin` default ACLs;
2. builds a reviewed inventory of existing `supabase_admin`-owned public
   routines, including their routine kind;
3. rehearses and applies a privileged procedure that hardens both default-ACL
   scopes for future routines;
4. explicitly revokes the reviewed existing inventory without a broad loop or
   `REVOKE ... ON ALL ROUTINES`;
5. records pre-check and post-check evidence and a rollback decision.

Do not mark D-2 fixed from a local database. A local pgTAP pass records the
local limitation only. D-2 is closed only when the hosted post-check evidence
shows that neither default-ACL scope grants `EXECUTE` to `PUBLIC`, `anon`,
`authenticated`, or `service_role`, and every reviewed existing routine has the
intended effective grants.

## Scope and non-goals

In scope:

- the `supabase_admin` global default function ACL (`defaclnamespace = 0`);
- the `supabase_admin` `public`-schema default function ACL;
- existing routines in schema `public` owned by `supabase_admin`.

Out of scope:

- application `SECURITY DEFINER` routines owned by `postgres` or
  `onedash_function_owner`. Phase 4C.0.3 migrations revoke and re-grant those
  explicitly. `supabase/tests/database/011_phase4c01_audit_remediation.sql`
  verifies the application ACL matrix, and
  `supabase/tests/database/013_phase4c03_final_audit_remediation.sql` verifies
  the global and public-schema default-ACL scopes for the roles the migration
  can administer.
- routines in other schemas, extension-owned routines, and platform objects
  that are not in the reviewed inventory.
- customer monitoring, `createRealChecker`, the execution gate, and egress
  isolation. This runbook changes function grants only.

Do not use `revoke execute on all routines in schema public` or a PL/pgSQL loop
that revokes every routine owned by `supabase_admin`. Those shortcuts also
revoke intentional grants on application RPCs such as `waitlist_count()`,
`ensure_my_account()`, the organization RLS helpers, the worker functions, and
reviewed platform APIs. They are not an acceptable remediation.

## How PostgreSQL 17 and Supabase default ACLs work

PostgreSQL stores default ACLs in `pg_catalog.pg_default_acl`, keyed by:

- `defaclrole` - the role that will own the future object;
- `defaclnamespace` - `0` for global defaults, or a schema OID for per-schema
  defaults;
- `defaclobjtype` - `f` for routines, `r` for tables, and so on.

Two rules matter for this remediation:

1. **Both scopes are additive.** The effective default ACL for a new routine is
   the union of the global defaults and the matching per-schema defaults.
   A per-schema `REVOKE` cannot cancel a global `GRANT`. The runbook must
   inspect and harden both scopes.
2. **Defaults affect only future objects.** Existing routines keep their current
   `proacl`. They must be revoked explicitly from the reviewed inventory.

For PostgreSQL 17, `ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS` and
`... ON ROUTINES` are equivalent. The `f` default-ACL object type covers normal
functions, aggregate functions, window functions, and procedures. It is not
possible to set separate defaults for those kinds.

Routine kind is still relevant when revoking an existing object. `pg_proc.prokind`
is `f` (function), `p` (procedure), `a` (aggregate), or `w` (window function):

| `prokind` | Kind | Valid explicit revoke |
| --- | --- | --- |
| `f` | function | `REVOKE EXECUTE ON FUNCTION ...` or `ON ROUTINE` |
| `a` | aggregate | `REVOKE EXECUTE ON FUNCTION ...` or `ON ROUTINE` |
| `w` | window function | `REVOKE EXECUTE ON FUNCTION ...` or `ON ROUTINE` |
| `p` | procedure | `REVOKE EXECUTE ON PROCEDURE ...` or `ON ROUTINE` |

`ON FUNCTION` fails with `is not a function` for a procedure. Prefer
`ON ROUTINE` for a mixed inventory because it is valid for every `prokind`.

The local verification database confirms the limitation this runbook exists to
close:

```text
postgres: rolsuper = false
postgres: member of supabase_admin = false
supabase_admin: rolsuper = true
supabase_admin: default function ACL may exist globally and/or in public
```

## Preconditions

- A maintenance window and an approved change record.
- A connection as `supabase_admin` or a superuser that can
  `SET ROLE supabase_admin`.
- A current database backup or provider snapshot.
- A staging rehearsal of every platform feature that might depend on a routine
  in the inventory.
- The expected application ACL matrix from
  `supabase/tests/database/011_phase4c01_audit_remediation.sql` available for
  comparison.
- Agreement that D-2 stays open until the hosted post-check evidence is attached
  to the release.

## Build the reviewed inventory

Run these read-only queries as the privileged operator and save the output with
the change record.

### 1. Confirm the operator identity

```sql
select current_user as current_user,
       r.rolsuper,
       pg_has_role(current_user, 'supabase_admin', 'member') as is_admin_member
from pg_roles r
where r.rolname = current_user;
```

Proceed only when `current_user = 'supabase_admin'`, or `rolsuper` is true, or
the session can `SET ROLE supabase_admin`.

### 2. Record both default-ACL scopes

```sql
select d.defaclrole::regrole as owner,
       case
         when d.defaclnamespace = 0 then '(global)'
         else d.defaclnamespace::regnamespace::text
       end as scope,
       d.defaclobjtype,
       d.defaclacl
from pg_default_acl d
where d.defaclrole = 'supabase_admin'::regrole
  and d.defaclobjtype = 'f'
order by scope;
```

A missing row is not proof of safety if the other scope grants `EXECUTE`. Also
run the expanded grantee query below. Record an empty result when no row exists
for a scope.

```sql
select case
         when d.defaclnamespace = 0 then '(global)'
         else d.defaclnamespace::regnamespace::text
       end as scope,
       coalesce(grantee.rolname, 'PUBLIC') as grantee,
       acl.privilege_type
from pg_default_acl d
cross join lateral pg_catalog.aclexplode(d.defaclacl) as acl
left join pg_roles grantee on grantee.oid = acl.grantee
where d.defaclrole = 'supabase_admin'::regrole
  and d.defaclobjtype = 'f'
  and acl.privilege_type = 'EXECUTE'
order by scope, grantee;
```

### 3. List every candidate routine owned by `supabase_admin` in `public`

```sql
select p.oid::regprocedure as signature,
       p.prokind,
       case p.prokind
         when 'f' then 'function'
         when 'p' then 'procedure'
         when 'a' then 'aggregate'
         when 'w' then 'window'
       end as routine_kind,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       coalesce(e.extname, '') as extension_name,
       p.proacl,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')
         as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE')
         as service_role_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join pg_depend d
  on d.classid = 'pg_proc'::regclass
 and d.objid = p.oid
 and d.deptype = 'e'
left join pg_extension e on e.oid = d.refobjid
where n.nspname = 'public'
  and pg_get_userbyid(p.proowner) = 'supabase_admin'
order by p.oid::regprocedure::text;
```

If this returns no rows, record an empty inventory. That is a valid result; the
default-ACL change still applies to routines created in the future by
`supabase_admin`.

### 4. Generate candidate revoke statements for review only

```sql
select case p.prokind
         when 'p' then format(
           'revoke execute on procedure %s from public, anon, authenticated, service_role;',
           p.oid::regprocedure
         )
         else format(
           'revoke execute on routine %s from public, anon, authenticated, service_role;',
           p.oid::regprocedure
         )
       end as candidate_statement
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_userbyid(p.proowner) = 'supabase_admin'
order by p.oid::regprocedure::text;
```

Do **not** execute this query's output as a block. Treat it as a review aid and
copy only approved rows into the explicit remediation script. `ON ROUTINE` is
used for `f`/`a`/`w`, and `ON PROCEDURE` is used for `p`.

### 5. Record the reviewed decisions

For every candidate, record:

| Signature | prokind | Owner | Security definer | Extension | Intended caller | Decision | Justification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `public.<signature>(<args>)` | f/p/a/w | `supabase_admin` | yes/no | name or empty | anon/authenticated/service_role/internal | revoke/keep/regrant | review note |

Review rules:

- **Revoke** routines that are not intentionally callable by an API role.
- **Keep** a platform routine only when the platform feature is documented to
  require that caller and the staging rehearsal passed. Record the reason.
- **Do not revoke** extension-owned routines. They are managed by their
  extension.
- **Do not revoke** application RPCs or worker functions that happen to appear
  in the catalog; verify ownership first. The intended application matrix is in
  `011_phase4c01_audit_remediation.sql`.
- **Stop** if ownership, routine kind, extension membership, or caller intent is
  unclear.

## Privileged remediation procedure

### Step 1: Rehearse the default-ACL procedure in staging

The procedure below checks that the caller is privileged, then hardens both the
global and `public`-schema `supabase_admin` default function ACLs. It is a
temporary procedure so it disappears with the session. It changes future
defaults only; it does not revoke any existing routine.

```sql
create or replace procedure pg_temp.onedash_d2_harden_function_defaults()
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_privileged boolean;
  v_scope text;
begin
  select r.rolsuper
         or r.rolname = 'supabase_admin'
         or pg_catalog.pg_has_role(current_user, 'supabase_admin', 'member')
    into v_privileged
  from pg_catalog.pg_roles r
  where r.rolname = current_user;

  if not coalesce(v_privileged, false) then
    raise exception 'D-2 remediation requires supabase_admin or a superuser'
      using errcode = '42501',
            hint = 'Reconnect as supabase_admin or a superuser. Do not run this as the migration postgres role.';
  end if;

  -- PostgreSQL 17: a per-schema REVOKE cannot cancel a global GRANT, so both
  -- scopes must be hardened. ON FUNCTIONS covers f, p, a, and w routines.
  foreach v_scope in array array['', ' in schema public'] loop
    execute pg_catalog.format(
      'alter default privileges for role supabase_admin%s revoke execute on functions from public, anon, authenticated, service_role',
      v_scope
    );
  end loop;
end;
$$;

begin;
set local lock_timeout = '5s';
call pg_temp.onedash_d2_harden_function_defaults();
commit;
```

If the procedure raises `42501` or `insufficient_privilege`, stop. D-2 remains
open. Do not substitute a migration run as `postgres`, and do not attempt to
repair the default ACL by granting broader privileges elsewhere.

### Step 2: Revoke the reviewed existing inventory explicitly

Use one statement per approved signature. Keep only reviewed rows. Do not paste
the generator output wholesale.

```sql
begin;
set local lock_timeout = '5s';

-- Copy only reviewed inventory rows. Examples of the required form:
-- revoke execute on routine public.<reviewed_function>(<reviewed_args>)
--   from public, anon, authenticated, service_role;
-- revoke execute on procedure public.<reviewed_procedure>(<reviewed_args>)
--   from public, anon, authenticated, service_role;

commit;
```

If the reviewed inventory is empty, skip this step and record that no existing
routines were revoked. Use `ON ROUTINE` for functions, aggregates, and window
functions; use `ON PROCEDURE` for procedures. `ON FUNCTION` is invalid for a
procedure.

### Step 3: Re-grant only reviewed platform routines that need API access

If staging proves a reviewed platform routine must stay callable, re-grant the
minimum role after the transaction and record why:

```sql
grant execute on routine public.<reviewed_platform_routine>(<reviewed_args>)
  to authenticated;
```

Use `ON PROCEDURE` instead when the object is a procedure and your PostgreSQL
version or tooling rejects `ON ROUTINE`. Do not restore the permissive
`supabase_admin` default ACL to make a platform feature work. Fix the
individual routine grant instead.

## Post-check and verification

Run the pre-check queries again. Record the before and after output.

### Default-ACL check

```sql
select case
         when d.defaclnamespace = 0 then '(global)'
         else d.defaclnamespace::regnamespace::text
       end as scope,
       coalesce(grantee.rolname, 'PUBLIC') as grantee,
       acl.privilege_type
from pg_default_acl d
cross join lateral pg_catalog.aclexplode(d.defaclacl) as acl
left join pg_roles grantee on grantee.oid = acl.grantee
where d.defaclrole = 'supabase_admin'::regrole
  and d.defaclobjtype = 'f'
  and acl.privilege_type = 'EXECUTE'
order by scope, grantee;
```

Expected after remediation:

- no `anon`, `authenticated`, `service_role`, or PUBLIC (`grantee` displayed as
  `PUBLIC`) row in either the `(global)` or `public` scope;
- `postgres` may retain `EXECUTE` as the trusted migration/operator role;
- no other unexpected grantee;
- if a scope had no `pg_default_acl` row before remediation, record that the
  procedure ran successfully and that the effective post-check still shows no
  API-role grant.

### Existing-routine check

The candidate query from step 3 must show `anon_execute = false`,
`authenticated_execute = false`, and `service_role_execute = false` for every
routine approved for revocation. Any approved `keep` or `regrant` routine must
have an explicit, recorded justification. Check `prokind` as part of the review
so a procedure is not mistaken for a function.

### Application ACL check

Run the catalog tests against the hosted database through the normal release
process, or execute their assertions manually if the hosted environment does not
permit pgTAP:

```bash
npx supabase test db --linked supabase/tests/database/011_phase4c01_audit_remediation.sql
npx supabase test db --linked supabase/tests/database/013_phase4c03_final_audit_remediation.sql
```

`011` covers the application effective ACL matrix and the legitimate public RPC
and worker grants. `013` covers the global and public-schema default-ACL scopes
for `postgres` and `onedash_function_owner`, effective permissions for newly
created functions, API-role denials, and preservation of legitimate grants.
Neither file asserts that the hosted `supabase_admin` default ACL is fixed; that
is this runbook's recorded post-check.

Also verify the application still works: waitlist count, signup/login,
dashboard monitor list, and the organization RLS helper paths. Verify every
platform feature touched by the inventory in staging before production.

## Record

Record the following in the release evidence:

- hosted project reference and environment;
- operator identity, `rolsuper`/membership result, and timestamp;
- output of both default-ACL pre-checks, including an explicit empty result for
  any missing scope;
- the complete candidate inventory with `prokind`, extension membership, and
  the reviewed decision table, including the zero-candidate result if
  applicable;
- the exact privileged procedure text and the exact explicit revocation
  statements that were run;
- pre-check and post-check output for both default-ACL scopes;
- pre-check and post-check effective permissions for every reviewed routine;
- output of the hosted verification tests or manual assertions;
- list of any explicitly re-granted platform routines and the justification;
- confirmation that no customer monitoring, real checker wiring, execution-gate
  change, or application deployment was performed by this runbook.

D-2 may be marked closed only when the hosted post-check evidence is attached to
the release and shows no unintended API-role `EXECUTE` grant in either default
scope. A local database reset or local pgTAP pass is not closure evidence.

## Rollback

Default-ACL and `REVOKE` changes are transactional until committed, but there is
no automatic rollback after commit. To restore access for a specific reviewed
routine, re-grant `EXECUTE` to the minimum role and record the reason:

```sql
grant execute on routine public.<reviewed_routine>(<reviewed_args>)
  to <reviewed_role>;
```

Do not restore the permissive `supabase_admin` default ACL. If a future routine
created after remediation needs API access, grant it explicitly after creation.
If the default-ACL procedure fails before `commit`, run `rollback` and leave D-2
open.

## Scope boundary

This runbook addresses D-2 only. It does not enable customer monitoring, does
not wire `createRealChecker` into the database worker, does not change the
default-disabled execution gate, and does not replace the production
egress-isolation work required before customer activation.
