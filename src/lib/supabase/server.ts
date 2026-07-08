import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client.
 *
 * Use this in Server Components, Route Handlers, and Server Actions.
 * It reads/writes cookies to keep the user's auth session alive.
 *
 * WHY A DIFFERENT CLIENT?
 * The browser client (supabase-client.ts) runs in the browser and uses
 * localStorage. But server components run on Vercel's servers, where
 * there's no browser. So we use cookies to pass the auth session back
 * and forth between browser and server.
 *
 * The flow:
 *   Browser sends cookie → middleware refreshes it → server reads it
 *   → knows who you are → renders your dashboard.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  );
}
