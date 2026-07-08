import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback route — handles the link users click in their confirmation email.
 *
 * THE EMAIL CONFIRMATION FLOW:
 *   1. User signs up at /signup
 *   2. Supabase sends them an email with a link
 *   3. They click the link
 *   4. The link brings them here (/auth/callback?code=...)
 *   5. We exchange the code for a session
 *   6. We redirect them to /dashboard (they're now logged in!)
 *
 * This is the standard OAuth-style flow. The "code" in the URL is a one-time
 * secret that proves "yes, this email is really theirs."
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const origin = requestUrl.origin;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Success! Send them to the dashboard.
      return NextResponse.redirect(`${origin}/dashboard`);
    }
  }

  // If something went wrong (expired code, tampered link), send to login
  // with an error message we can display.
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
