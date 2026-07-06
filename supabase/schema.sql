-- ============================================================
-- OneDash v0.2 — Database schema (waitlist table)
-- ============================================================
-- Run this in Supabase Dashboard → SQL Editor → New query → Paste → Run
--
-- This creates the waitlist table AND the security rules (RLS).
-- After running, your form will work end-to-end.
-- ============================================================

-- 1. Create the waitlist table
CREATE TABLE IF NOT EXISTS public.waitlist (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  created_at  timestamp with time zone DEFAULT now(),
  source      text DEFAULT 'landing_page'
);

-- 2. Enable Row Level Security (the magic that keeps us safe)
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- 3. SECURITY RULE #1: Anyone can INSERT their email (sign up for waitlist)
--    This is what makes the public form work.
CREATE POLICY "Anyone can join the waitlist"
  ON public.waitlist
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- 4. SECURITY RULE #2: Anonymous users can see the COUNT (so we can show
--    "You're #N on the list!") but NOT the actual emails.
--    We do this by allowing SELECT but only exposing the count via a function.
CREATE OR REPLACE FUNCTION public.waitlist_count()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM public.waitlist;
$$;

-- 5. Add a comment so future-you remembers what this is all for
COMMENT ON TABLE public.waitlist IS
  'OneDash waitlist — collected from landing page before launch. RLS: anon can INSERT (sign up) and read COUNT, but never individual emails.';

-- ============================================================
-- ✅ Done! After running this:
--   - The waitlist form will save emails to this table
--   - You can view signups in: Table Editor → waitlist
--   - Strangers can't read or delete anyone's email
-- ============================================================

-- 💡 TO VIEW SIGNUPS LATER, run this in the SQL editor:
-- SELECT * FROM public.waitlist ORDER BY created_at DESC;
