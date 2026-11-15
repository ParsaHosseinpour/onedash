# Supabase admin function ACL runbook (D-2)

## Purpose

Phase 4C.0.2 does not fix finding D-2. On a hosted Supabase project, the
`supabase_admin` role owns a default function ACL in schema `public` that grants
`EXECUTE` to `postgres`, `anon`, `authenticated`, and `service_role`. A migration
run by the local `postgres` role cannot alter that superuser's default or revoke
privileges on functions owned by `supabase_admin`.

This runbook is the privileged, hosted-only remediation path. It:

1. builds a reviewed inventory of existing `supabase_admin`-owned public
   functions;
2. changes the `supabase_admin` default ACL for future functions;
3. explicitly revokes the reviewed inventory without using a broad loop or
   `REVOKE ... ON ALL FUNCTIONS`;
4. records pre-check and post-check evidence.

Do not mark D-2 fixed from a local database. D-2 remains **open** until this
runbook has been completed on the hosted project and the recorded post-check
output shows no unintended API-role `EXECUTE` grant. A local pgTAP pass only
records the local limitation.

## Scope and non-goals

In scope:

- the `supabase_admin` default function ACL in schema `public`;
- existing functions in schema `public` owned by `supabase_admin`.

Out of scope:

- application `SECURITY DEFINER` functions owned by `postgres` or
  `onedash_function_owner`. The Phase 4C.0.1/4C.0.2 migrations revoke and regrant
  those explicitly, and `supabase/tests/database/011_phase4c01_audit_remediation.sql`
  verifies the complete 35-function matrix.
- functions in other schemas, extension-owned functions, and platform objects
  that are not in the reviewed inventory.
- customer monitoring, `createRealChecker`, the execution gate, and egress
  isolation. This runbook changes function grants only.

Do not use `revoke execute on all functions in schema public` or a PL/pgSQL loop
that revokes every function owned by `supabase_admin`. Those shortcuts also
revoke intentional grants on application RPCs such as `waitlist_count()`,
`ensure_my_account()`, the organization RLS helpers, the worker functions, and
reviewed platform APIs. They are not an acceptable remediation.

## Why the local migration cannot fix D-2

The local verification database confirms:

```text
postgres: rolsuper = false
postgres: member of supabase_admin = false
supabase_admin: rolsuper = true
supabase_admin default ACL in public: EXECUTE to
  postgres, anon, authenticated, service_role
```

The Phase 4C.0.1/4C.0.2 migrations therefore:

- revoke direct application-role grants on the 35 application
  `SECURITY DEFINER` functions and re-grant only the intended RPCs and worker
  functions;
- harden the default ACLs of `postgres` and `onedash_function_owner`;
- report the `supabase_admin` limitation as an external blocker instead of
  claiming it is fixed.

## Preconditions

- A maintenance window and an approved change record.
- A connection as `supabase_admin` or a superuser that can
  `SET ROLE supabase_admin`.
- A current database backup or provider snapshot.
- A staging rehearsal of every platform feature that might depend on a function
  in the inventory.
- The expected application ACL matrix from
  `supabase/tests/database/011_phase4c01_audit_remediation.sql` available for
  comparison.

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

### 2. Record the current `supabase_admin` default ACL

```sql
select d.defaclrole::regrole as owner,
       d.defaclnamespace::regnamespace as schema,
       d.defaclobjtype,
       d.defaclacl
from pg_default_acl d
where d.defaclrole = 'supabase_admin'::regrole
  and d.defaclnamespace = 'public'::regnamespace;
```

### 3. List every candidate function owned by `supabase_admin` in `public`

```sql
select p.oid::regprocedure as signature,
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
default-ACL change in the next section still applies to functions created in the
future by `supabase_admin`.

### 4. Generate candidate revoke statements for review only

```sql
select format(
         'revoke execute on function %s from public, anon, authenticated, service_role;',
         p.oid::regprocedure
       ) as candidate_statement
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_userbyid(p.proowner) = 'supabase_admin'
order by p.oid::regprocedure::text;
```

Do **not** execute this query's output as a block. Treat it as a review aid and
copy only approved rows into the explicit remediation script.

### 5. Record the reviewed decisions

For every candidate, record:

| Signature | Owner | Security definer | Extension | Intended caller | Decision | Justification |
| --- | --- | --- | --- | --- | --- | --- |
| `public.<signature>(<args>)` | `supabase_admin` | yes/no | name or empty | anon/authenticated/service_role/internal | revoke/keep/regrant | review note |

Review rules:

- **Revoke** functions that are not intentionally callable by an API role.
- **Keep** a platform function only when the platform feature is documented to
  require that caller and the staging rehearsal passed. Record the reason.
- **Do not revoke** extension-owned functions. They are managed by their
  extension.
- **Do not revoke** application RPCs or worker functions that happen to appear
  in the catalog; verify ownership first. The intended application matrix is in
  `011_phase4c01_audit_remediation.sql`.
- **Stop** if ownership, extension membership, or caller intent is unclear.

## Remediation

### Step 1: Harden future functions created by `supabase_admin`

This statement changes default privileges only. It does not change access to any
existing function. Run it in its own transaction:

```sql
begin;
set local lock_timeout = '5s';

alter default privileges for role supabase_admin in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

commit;
```

If the role lacks permission, stop. D-2 remains open. Do not substitute a
migration run as `postgres`.

### Step 2: Revoke the reviewed existing inventory explicitly

Use one statement per approved signature. Replace the placeholders with exact
signatures from the reviewed inventory and keep only approved rows. Do not paste
the generator output wholesale.

```sql
begin;
set local lock_timeout = '5s';

-- Copy only reviewed inventory rows. Examples of the required form:
-- revoke execute on function public.<reviewed_function>(<reviewed_args>)
--   from public, anon, authenticated, service_role;
-- revoke execute on function public.<another_reviewed_function>(<reviewed_args>)
--   from public, anon, authenticated, service_role;

commit;
```

If the reviewed inventory is empty, skip this step and record that no existing
functions were revoked.

### Step 3: Re-grant only reviewed platform functions that need API access

If the staging rehearsal proves a reviewed platform function must stay callable,
re-grant the minimum role after the transaction and record why:

```sql
grant execute on function public.<reviewed_platform_function>(<reviewed_args>)
  to authenticated;
```

Do not restore the permissive `supabase_admin` default ACL to make a platform
feature work. Fix the individual function grant instead.

## Post-check and verification

Run the pre-check queries again. Record the before and after output.

### Default-ACL check

```sql
select a.grantee::regrole as grantee,
       a.privilege_type
from pg_default_acl d
cross join lateral aclexplode(d.defaclacl) a
where d.defaclrole = 'supabase_admin'::regrole
  and d.defaclnamespace = 'public'::regnamespace
  and d.defaclobjtype = 'f'
  and a.privilege_type = 'EXECUTE'
order by a.grantee::regrole::text;
```

Expected after remediation:

- no `anon`, `authenticated`, `service_role`, or PUBLIC (`grantee = 0`) row;
- `postgres` may retain `EXECUTE` as the trusted migration/operator role;
- no other unexpected grantee.

### Existing-function check

The candidate query from step 3 must show `anon_execute = false`,
`authenticated_execute = false`, and `service_role_execute = false` for every
function that was approved for revocation. Any approved `keep` or `regrant`
function must have an explicit, recorded justification.

### Application ACL check

Run the catalog test against the hosted database through the normal release
process, or execute its assertions manually if the hosted environment does not
permit pgTAP:

```bash
npx supabase test db --linked supabase/tests/database/011_phase4c01_audit_remediation.sql
```

The file currently contains 47 assertions covering the complete 35-function
effective ACL matrix, unexpected grantees, the public-schema `postgres` default
ACL, and preservation of the legitimate public RPC and worker grants. It does
not assert that the hosted `supabase_admin` default ACL is fixed; that is this
runbook's recorded post-check.

Also verify the application still works: waitlist count, signup/login,
dashboard monitor list, and the organization RLS helper paths. Verify every
platform feature touched by the inventory in staging before production.

## Record

Record the following in the release evidence:

- hosted project reference and environment;
- operator identity and timestamp;
- output of the identity and default-ACL pre-checks;
- the complete candidate list and the reviewed decision table, including the
  zero-candidate result if applicable;
- the exact explicit revocation statements that were run;
- pre-check and post-check default-ACL and existing-function output;
- output of the verification test or manual assertions;
- list of any explicitly re-granted platform functions and the justification;
- confirmation that no customer monitoring, real checker wiring, or gate change
  was performed by this runbook.

D-2 may be marked closed only when the hosted post-check evidence is attached to
the release. A local database reset or local pgTAP pass is not closure evidence.

## Rollback

There is no automatic rollback; the remediation removes grants. To restore a
specific reviewed function, re-grant `EXECUTE` to the minimum role and record the
reason. Do not restore the permissive `supabase_admin` default ACL. Fix the
individual function instead.

## Scope boundary

This runbook addresses D-2 only. It does not enable customer monitoring, does not
wire `createRealChecker` into the database worker, does not change the
default-disabled execution gate, and does not replace the production
egress-isolation work required before customer activation.
