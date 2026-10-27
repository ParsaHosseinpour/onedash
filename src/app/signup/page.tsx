import Link from "next/link";
import { redirect } from "next/navigation";
import ConfigurationNotice from "@/app/components/ConfigurationNotice";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import SignupForm from "./SignupForm";

// Never pre-render an auth page with build-time configuration.
export const dynamic = "force-dynamic";

/**
 * /signup page (server component).
 *
 * Same pattern as /login: check if already logged in → redirect to dashboard.
 * Otherwise render the signup form (client component).
 */
export default async function SignupPage() {
  if (!isSupabaseConfigured()) {
    return <ConfigurationNotice />;
  }

  const supabase = await createClient();

  const session = await supabase.auth.getUser().catch((error) => {
    console.error("Could not check the existing session.", error);
    return null;
  });

  if (session?.data?.user) {
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
          <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
          <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
            Free forever for commercial use · No credit card required
          </p>
        </div>

        <SignupForm />

        <p className="mt-6 text-center text-sm text-[color:var(--foreground-muted)]">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-[color:var(--accent)] hover:underline"
          >
            Log in
          </Link>
        </p>

        <p className="mt-4 text-center text-xs text-[color:var(--foreground-muted)]">
          By signing up, you agree to receive a confirmation email.
          We&apos;ll never spam you.
        </p>
      </div>
    </main>
  );
}
