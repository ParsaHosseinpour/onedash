import { NextResponse, type NextRequest } from "next/server";
import { createProxyClient } from "@/lib/supabase/proxy";
import { isSupabaseConfigured } from "@/lib/env";

/**
 * Proxy — runs before matching requests.
 *
 * Its only job is to refresh the Supabase auth session so server components
 * receive a valid cookie. Authorization remains in the data/page layer
 * (`requireUser`), never in Proxy alone.
 */

let warnedAboutMissingConfig = false;

export async function proxy(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    if (!warnedAboutMissingConfig) {
      console.error(
        "Supabase environment variables are missing or invalid. Session refresh is disabled; auth routes will be unavailable until they are configured."
      );
      warnedAboutMissingConfig = true;
    }

    return NextResponse.next();
  }

  try {
    const { supabase, getResponse } = createProxyClient(request);
    try {
      await supabase.auth.getUser();
    } catch (error) {
      // Keep any refreshed cookies that were already written. Protected pages
      // still call getUser() and fail closed if the session is invalid.
      console.error("Supabase session refresh failed in proxy.", error);
    }
    return getResponse();
  } catch (error) {
    // Do not take the whole marketing site down because session refresh
    // failed. Protected pages still call getUser() and redirect if needed.
    console.error("Supabase session refresh failed in proxy.", error);
    return NextResponse.next();
  }
}

/**
 * Skip static assets. Everything else (including auth pages and the API) goes
 * through the proxy so cookies are refreshed consistently.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|ico|woff|woff2)$).*)",
  ],
};
