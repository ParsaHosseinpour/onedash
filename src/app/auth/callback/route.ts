import { NextResponse } from "next/server";
import { sanitizeNextPath } from "@/lib/auth-validation";
import { ConfigurationError, getSiteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * Handles the link in the Supabase confirmation email.
 *
 * The redirect origin comes from NEXT_PUBLIC_SITE_URL, never from the incoming
 * Host header. The `next` path is restricted to an allowlist.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  let siteUrl: string;
  try {
    siteUrl = getSiteUrl();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Auth callback is unavailable.", error.message);
    } else {
      console.error("Could not determine the canonical site URL.", error);
    }

    return NextResponse.json(
      { error: "Authentication is not configured on this deployment." },
      { status: 503 }
    );
  }

  const code = requestUrl.searchParams.get("code");
  const nextPath = sanitizeNextPath(requestUrl.searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=auth_callback_failed", siteUrl)
    );
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error("Auth code exchange failed.", { code: error.code });
      return NextResponse.redirect(
        new URL("/login?error=auth_callback_failed", siteUrl)
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Auth callback is unavailable.", error.message);
      return NextResponse.json(
        { error: "Authentication is not configured on this deployment." },
        { status: 503 }
      );
    }

    console.error("Auth callback threw unexpectedly.", error);
    return NextResponse.redirect(
      new URL("/login?error=auth_callback_failed", siteUrl)
    );
  }

  return NextResponse.redirect(new URL(nextPath, siteUrl));
}
