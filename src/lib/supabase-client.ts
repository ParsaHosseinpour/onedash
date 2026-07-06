import { createClient } from "@supabase/supabase-js";

/**
 * Supabase browser client.
 *
 * This is the single connection point between our frontend and the database.
 * Every part of OneDash that needs to read/write data imports this.
 *
 * The "anon" key here is SAFE to expose in the browser because Supabase's
 * Row Level Security (RLS) decides what's actually allowed — the key alone
 * grants nothing. See BUSINESS.md / TECH.md for the founder explanation.
 *
 * NEXT_PUBLIC_ prefix = Next.js exposes this variable to the browser.
 * Without the prefix, it'd only be available on the server.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase env vars. Did you set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local?"
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
