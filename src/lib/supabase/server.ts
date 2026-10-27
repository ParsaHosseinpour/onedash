import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicEnv } from "@/lib/env";

/**
 * Server-side Supabase client.
 *
 * Use this in Server Components, Route Handlers, and Server Actions. It reads
 * and writes the same cookie-based session that the browser client uses.
 *
 * In a Server Component, cookie writes are not allowed; the proxy refreshes
 * the session before the request instead. In Server Actions and Route
 * Handlers, writes succeed and keep the browser and server in sync.
 */
export async function createClient() {
  // Read cookies first so Next.js marks the calling route as dynamic before we
  // validate configuration. That keeps `next build` from executing auth pages
  // without credentials.
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabasePublicEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component. The proxy refreshes the session,
          // so this is safe to ignore here.
        }
      },
    },
  });
}
