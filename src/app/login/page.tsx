import Link from "next/link";
import { redirect } from "next/navigation";
import ConfigurationNotice from "@/app/components/ConfigurationNotice";
import { sanitizeNextPath } from "@/lib/auth-validation";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import LoginForm from "./LoginForm";

// Auth pages must render per request so configuration and cookies are read at
// runtime, not frozen into a static build without credentials.
export const dynamic = "force-dynamic";

const LOGIN_ERROR_MESSAGES = new Map<string, string>([
  [
    "auth_callback_failed",
    "That sign-in link is invalid or expired. Please log in or request a new link.",
  ],
  [
    "session_check_failed",
    "We couldn't verify your session. Please log in again.",
  ],
  [
    "config",
    "Authentication is not configured on this deployment. Contact the site administrator.",
  ],
]);

/**
 * /login page (server component).
 *
 * The page checks whether the user is already authenticated and redirects to
 * an allowlisted post-login path. The actual form is a client component that
 * submits to a server action.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const nextPath = sanitizeNextPath(params.next);

  if (!isSupabaseConfigured()) {
    return <ConfigurationNotice />;
  }

  const supabase = await createClient();

  const session = await supabase.auth.getUser().catch((error) => {
    console.error("Could not check the existing session.", error);
    return null;
  });

  if (session?.data?.user) {
    redirect(nextPath);
  }

  const errorMessage = params.error
    ? LOGIN_ERROR_MESSAGES.get(params.error) ??
      "Something went wrong during sign in. Please try again."
    : null;

  return (
    <main className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2 mb-6">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[color:var(--accent)] text-[#0a0e1a] font-bold">
              1
            </div>
            <span className="font-semibold text-lg">OneDash</span>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
          <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
            Log in to your OneDash account
          </p>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-[color:var(--danger)] bg-[color:var(--danger)]/10 px-4 py-3 text-sm"
          >
            {errorMessage}
          </div>
        )}

        <LoginForm nextPath={nextPath} />

        <p className="mt-6 text-center text-sm text-[color:var(--foreground-muted)]">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="text-[color:var(--accent)] hover:underline"
          >
            Sign up free
          </Link>
        </p>
      </div>
    </main>
  );
}
