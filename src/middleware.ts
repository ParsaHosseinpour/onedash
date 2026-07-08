import { type NextRequest } from "next/server";
import { createMiddlewareClient } from "@/lib/supabase/middleware";

/**
 * Middleware — runs on EVERY request before the page loads.
 *
 * Job: refresh the user's auth session.
 *
 * Auth tokens expire (for security). When they do, Supabase issues a new one.
 * This middleware catches that refresh and updates the user's cookies,
 * so they stay logged in without noticing.
 *
 * Without this, users would get logged out every hour or so. Bad UX.
 *
 * We DON'T do route protection here (could, but it's cleaner to do it
 * inside each protected page — see app/dashboard/page.tsx).
 */
export async function middleware(request: NextRequest) {
  const { supabase, response } = createMiddlewareClient(request);

  // Refresh the session. This is the key line.
  await supabase.auth.getUser();

  return response;
}

/**
 * Matcher — which routes should middleware run on?
 *
 * We skip static assets (images, CSS) so we don't slow down the site.
 * Everything else goes through middleware.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|css|js|gif|webp)$).*)",
  ],
};
