"use client";

import Link from "next/link";

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex-1">
      <section className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">
          The monitor dashboard is unavailable
        </h1>
        <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
          We could not load monitor configuration. Your saved data was not
          changed. Try again, or return to the dashboard.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)]"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="rounded-lg border border-[color:var(--border)] px-4 py-2 text-sm hover:bg-[color:var(--background-elevated)]"
          >
            Back to dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
