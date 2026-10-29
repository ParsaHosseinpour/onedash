export default function DashboardLoading() {
  return (
    <main className="flex-1" aria-busy="true" aria-live="polite">
      <div className="border-b border-[color:var(--border)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="h-7 w-40 animate-pulse rounded bg-[color:var(--background-elevated)]" />
          <div className="h-9 w-24 animate-pulse rounded bg-[color:var(--background-elevated)]" />
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <p className="sr-only">Loading monitors…</p>
        <div className="h-8 w-48 animate-pulse rounded bg-[color:var(--background-elevated)]" />
        <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-[color:var(--background-elevated)]" />
        <div className="mt-8 space-y-4">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-40 animate-pulse rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-elevated)]"
            />
          ))}
        </div>
      </div>
    </main>
  );
}
