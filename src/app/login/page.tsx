import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LoginForm from "./LoginForm";

/**
 * /login page (server component).
 *
 * Server component because we need to check: "is the user already logged in?"
 * If they are, redirect them to the dashboard — no point showing login twice.
 *
 * The actual form is a separate client component (LoginForm.tsx) because
 * it has interactive state (loading spinner, error messages).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();

  // Already logged in? Skip login page, go to dashboard.
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    redirect("/dashboard");
  }

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

        {params.error && (
          <div className="mb-4 rounded-lg border border-[color:var(--danger)] bg-[color:var(--danger)]/10 px-4 py-3 text-sm">
            ⚠️ Something went wrong during sign in. Please try again.
          </div>
        )}

        <LoginForm />

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
