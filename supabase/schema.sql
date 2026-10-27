-- ============================================================
-- OneDash waitlist schema and security rules
-- ============================================================
-- Run this in Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- This script is idempotent for the current waitlist table. If existing rows
-- are invalid or contain case-insensitive duplicates, it stops with an
-- actionable error instead of silently deleting or rewriting data.
--
-- The application server route (/api/waitlist) is the supported write path.
-- The anon role still has INSERT permission because the public anon key can
-- call PostgREST directly. See the security notes at the bottom.
-- ============================================================

-- 1. Table ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.waitlist (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text NOT NULL,
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  source      text NOT NULL DEFAULT 'landing_page'
);

-- 2. Pre-flight checks on existing data ----------------------
-- Case-insensitive duplicates would make the unique index impossible.
DO $$
DECLARE
  duplicate_groups integer;
BEGIN
  SELECT count(*) INTO duplicate_groups
  FROM (
    SELECT lower(btrim(email))
    FROM public.waitlist
    GROUP BY 1
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION
      'Waitlist hardening stopped: % case-insensitive duplicate email group(s) exist. Inspect with: SELECT lower(btrim(email)), count(*) FROM public.waitlist GROUP BY 1 HAVING count(*) > 1;',
      duplicate_groups;
  END IF;
END $$;

-- Rows that do not look like an email must be cleaned up manually.
DO $$
DECLARE
  invalid_rows integer;
BEGIN
  SELECT count(*) INTO invalid_rows
  FROM public.waitlist
  WHERE email IS NULL
     OR char_length(btrim(email)) NOT BETWEEN 3 AND 254
     OR btrim(email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';

  IF invalid_rows > 0 THEN
    RAISE EXCEPTION
      'Waitlist hardening stopped: % row(s) have invalid emails. Inspect with: SELECT id, email FROM public.waitlist WHERE email IS NULL OR char_length(btrim(email)) NOT BETWEEN 3 AND 254 OR btrim(email) !~ ''^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'';',
      invalid_rows;
  END IF;
END $$;

-- The only supported source in Phase 1 is the landing page.
DO $$
DECLARE
  invalid_sources integer;
BEGIN
  SELECT count(*) INTO invalid_sources
  FROM public.waitlist
  WHERE source IS NOT NULL AND source <> 'landing_page';

  IF invalid_sources > 0 THEN
    RAISE EXCEPTION
      'Waitlist hardening stopped: % row(s) have an unsupported source. Set them to landing_page or add the source to the allowlist.',
      invalid_sources;
  END IF;
END $$;

-- 3. Normalize safe legacy values ----------------------------
UPDATE public.waitlist
SET email = lower(btrim(email))
WHERE email <> lower(btrim(email));

UPDATE public.waitlist
SET created_at = now()
WHERE created_at IS NULL;

UPDATE public.waitlist
SET source = 'landing_page'
WHERE source IS NULL OR btrim(source) = '';

ALTER TABLE public.waitlist
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN source SET DEFAULT 'landing_page',
  ALTER COLUMN source SET NOT NULL;

-- 4. Constraints ---------------------------------------------
ALTER TABLE public.waitlist
  DROP CONSTRAINT IF EXISTS waitlist_email_format_check;

ALTER TABLE public.waitlist
  ADD CONSTRAINT waitlist_email_format_check CHECK (
    char_length(email) BETWEEN 3 AND 254
    AND email = lower(btrim(email))
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  );

ALTER TABLE public.waitlist
  DROP CONSTRAINT IF EXISTS waitlist_source_check;

ALTER TABLE public.waitlist
  ADD CONSTRAINT waitlist_source_check CHECK (source = 'landing_page');

-- Enforce uniqueness regardless of case. The old case-sensitive constraint
-- is redundant once this index exists.
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_lower_key
  ON public.waitlist (lower(email));

ALTER TABLE public.waitlist
  DROP CONSTRAINT IF EXISTS waitlist_email_key;

-- 5. Row Level Security --------------------------------------
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Anonymous users may only INSERT. There is deliberately no SELECT,
-- UPDATE, or DELETE policy, so emails are not readable through the API.
DROP POLICY IF EXISTS "Anyone can join the waitlist" ON public.waitlist;

CREATE POLICY "Anyone can join the waitlist"
  ON public.waitlist
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    char_length(email) BETWEEN 3 AND 254
    AND email = lower(btrim(email))
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    AND source = 'landing_page'
  );

-- Least privilege: the API needs INSERT only. It never needs to read,
-- update, or delete waitlist rows.
REVOKE ALL ON TABLE public.waitlist FROM anon, authenticated;
GRANT INSERT ON TABLE public.waitlist TO anon, authenticated;

-- 6. Public count function -----------------------------------
-- SECURITY DEFINER lets anonymous visitors read the aggregate count without
-- granting SELECT on the table. Keep the empty search_path and fully qualify
-- every name so the function cannot be hijacked by a shadow object.
CREATE OR REPLACE FUNCTION public.waitlist_count()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*) FROM public.waitlist;
$$;

REVOKE ALL ON FUNCTION public.waitlist_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.waitlist_count() TO anon, authenticated;

COMMENT ON TABLE public.waitlist IS
  'OneDash waitlist. RLS: anon/authenticated may INSERT only; no email rows are readable. The app API adds validation and best-effort rate limiting.';

COMMENT ON FUNCTION public.waitlist_count() IS
  'Returns only the total waitlist count. Callable by anon/authenticated; table rows remain unreadable.';

-- ============================================================
-- Security notes
-- ============================================================
-- * The anon key is public. Because anon still has INSERT, a determined
--   attacker can bypass /api/waitlist and insert directly through PostgREST.
--   The route's in-process rate limit is a speed bump, not a shared quota.
--   Before launch, add a shared limiter (Redis/Upstash or a WAF) or revoke
--   anon INSERT and write through a server-only service-role endpoint.
-- * Do not add a SELECT policy for anon: individual emails must stay private.
-- * If you intentionally add new source values, update waitlist_source_check
--   and the RLS WITH CHECK expression together.
-- ============================================================
