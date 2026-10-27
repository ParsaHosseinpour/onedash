import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { ConfigurationError } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

const SUPABASE_AUTH_COOKIE =
  /^sb-.+-auth-token(?:\.\d+|-code-verifier)?$/;

/**
 * Authoritative authorization for protected pages and actions.
 *
 * Proxy redirects are only an optimistic UX optimization. Every protected
 * page calls this helper, which verifies the session with Supabase's Auth
 * server rather than trusting a cookie or a client-side claim.
 */
export async function requireUser(): Promise<User> {
  const supabase = await createClient().catch((error) => {
    if (error instanceof ConfigurationError) {
      console.error("Protected route is unavailable.", error.message);
      redirect("/login?error=config");
    }

    throw error;
  });

  const { data, error } = await supabase.auth.getUser().catch((error) => {
    console.error("Could not verify the Supabase session.", error);
    redirect("/login?error=session_check_failed");
  });
  const user = data?.user;

  // Fail closed: a present-but-errored response is not trusted.
  if (error || !user) {
    redirect("/login");
  }

  return user;
}

/**
 * Remove Supabase auth cookies from the response.
 *
 * `signOut()` normally does this, but clearing explicitly guarantees that a
 * failed network revocation cannot leave a usable session cookie in the
 * browser. Chunked cookies (`.0`, `.1`, ...) and the PKCE code verifier are
 * included.
 */
export async function clearSupabaseAuthCookies(): Promise<void> {
  const cookieStore = await cookies();

  for (const cookie of cookieStore.getAll()) {
    if (SUPABASE_AUTH_COOKIE.test(cookie.name)) {
      cookieStore.delete(cookie.name);
    }
  }
}
