import Link from "next/link";
import { requireUser } from "@/lib/auth";
import LogoutButton from "./LogoutButton";

// The dashboard depends on request cookies and must never be prerendered.
export const dynamic = "force-dynamic";

/**
 * /dashboard — the protected user dashboard.
 *
 * This is the FIRST page in OneDash that requires authentication.
 * The protection logic is simple:
 *
 *   1. Server reads the auth cookie
 *   2. Calls supabase.auth.getUser()
 *   3. If no user → redirect to /login
 *   4. If user → render the dashboard
 *
 * This is "route protection at the page level." Clean and reliable.
 *
 * In v0.4, this page will show the user's monitors. For now (v0.3),
 * it's a placeholder that confirms auth works end-to-end.
 */
export default async function DashboardPage() {
  // 🔒 AUTHORITATIVE CHECK: verifies the session with Supabase Auth. Proxy
  // redirects are only an optimistic optimization and are not trusted here.
  const user = await requireUser();

  return (
    <main className="flex-1">
      {/* Top nav specific to the app (not the marketing nav) */}
      <nav className="border-b border-[color:var(--border)]">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[color:var(--accent)] text-[#0a0e1a] font-bold text-sm">
              1
            </div>
            <span className="font-semibold tracking-tight">OneDash</span>
            <span className="text-xs text-[color:var(--foreground-muted)] ml-2">
              Dashboard
            </span>
          </div>
          <LogoutButton />
        </div>
      </nav>

      {/* Welcome banner */}
      <section className="border-b border-[color:var(--border)]">
        <div className="mx-auto max-w-6xl px-6 py-12">
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome, {user.email} 👋
          </h1>
          <p className="mt-2 text-[color:var(--foreground-muted)]">
            You&apos;re signed in. The monitoring dashboard arrives in v0.4.
          </p>
        </div>
      </section>

      {/* Placeholder cards for what's coming */}
      <section className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-6">
            <div className="text-2xl mb-2">📊</div>
            <h3 className="font-semibold">Monitors</h3>
            <p className="mt-1 text-sm text-[color:var(--foreground-muted)]">
              You have 0 monitors. Add your first endpoint in v0.4.
            </p>
          </div>
          <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-6">
            <div className="text-2xl mb-2">🔔</div>
            <h3 className="font-semibold">Incidents</h3>
            <p className="mt-1 text-sm text-[color:var(--foreground-muted)]">
              No incidents yet. That&apos;s a good thing.
            </p>
          </div>
          <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-6">
            <div className="text-2xl mb-2">📄</div>
            <h3 className="font-semibold">Status page</h3>
            <p className="mt-1 text-sm text-[color:var(--foreground-muted)]">
              Your public status page arrives in v0.7.
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-xl border border-dashed border-[color:var(--border)] p-8 text-center">
          <p className="text-[color:var(--foreground-muted)]">
            🚧 This dashboard is intentionally minimal in v0.3 — it proves
            authentication works end-to-end. Real monitoring UI arrives in v0.4.
          </p>
          <Link
            href="/"
            className="inline-block mt-4 text-sm text-[color:var(--accent)] hover:underline"
          >
            ← Back to home
          </Link>
        </div>
      </section>
    </main>
  );
}
