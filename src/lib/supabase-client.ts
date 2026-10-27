"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "@/lib/env";

/**
 * Cookie-based Supabase browser client.
 *
 * `@supabase/ssr` stores the session in cookies (not localStorage) so the
 * server sees exactly the same session as the browser. The client is created
 * lazily: importing this module during prerender must not require env values.
 */
let browserClient: SupabaseClient | undefined;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const { url, anonKey } = getSupabasePublicEnv();
    browserClient = createBrowserClient(url, anonKey);
  }

  return browserClient;
}
