import Link from "next/link";

export default function DashboardNotFound() {
  return (
    <main className="flex-1">
      <section className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-sm font-medium text-[color:var(--accent)]">404</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          Monitor not found
        </h1>
        <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
          This monitor does not exist, or it belongs to another organization.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-lg border border-[color:var(--border)] px-4 py-2 text-sm hover:bg-[color:var(--background-elevated)]"
        >
          Back to monitors
        </Link>
      </section>
    </main>
  );
}
