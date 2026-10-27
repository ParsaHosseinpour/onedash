import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicEnv } from "@/lib/env";

/**
 * Supabase client used by src/proxy.ts to refresh the auth session.
 *
 * Proxy runs before the page renders, so it uses NextRequest/NextResponse
 * instead of next/headers. Refreshed cookies are copied onto both the request
 * (so the page sees them) and the response (so the browser stores them).
 */
export function createProxyClient(request: NextRequest) {
  const { url, anonKey } = getSupabasePublicEnv();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );

        response = NextResponse.next({ request });

        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  return {
    supabase,
    // `response` is reassigned whenever Supabase refreshes a cookie. Return a
    // getter so the caller reads the response *after* `getUser()` completes,
    // rather than capturing the initial response object.
    getResponse: () => response,
  };
}
