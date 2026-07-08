import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Supabase client for middleware.
 *
 * Middleware runs on EVERY request before it reaches your page.
 * We use it to refresh the user's auth token (which expires periodically)
 * before the page renders. Without this, users would get logged out randomly.
 *
 * DIFFERENT FROM server.ts:
 * Middleware uses NextRequest (incoming request) instead of next/headers.
 * It can't use `cookies()` from next/headers because it runs earlier.
 */
export function createMiddlewareClient(request: NextRequest) {
  // Create a response object we can modify cookies on
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  return { supabase, response };
}
