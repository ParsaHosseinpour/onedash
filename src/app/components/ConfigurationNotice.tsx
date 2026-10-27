import Link from "next/link";

/**
 * Rendered instead of an auth form when Supabase configuration is absent.
 * Keep the public-facing copy friendly; operators can find the variable names
 * in the README and .env.example.
 */
export default function ConfigurationNotice() {
  return (
    <main className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md rounded-xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-6 text-center">
        <div className="text-4xl mb-3">🛠️</div>
        <h1 className="text-xl font-bold tracking-tight">
          Authentication is temporarily unavailable
        </h1>
        <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
          This deployment is missing its Supabase configuration. Please
          contact the site administrator.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
