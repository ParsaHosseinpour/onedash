import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { MONITOR_LIST_LIMIT } from "@/lib/monitor-config";
import { getMonitorWorkspace } from "@/lib/monitor-service";
import { createClient } from "@/lib/supabase/server";
import DashboardNav from "./DashboardNav";
import MonitorList from "./components/MonitorList";
import MonitoringNotice from "./components/MonitoringNotice";

// The dashboard depends on request cookies and must never be prerendered.
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const supabase = await createClient();
  const result = await getMonitorWorkspace(supabase, user.id);

  if (!result.ok) {
    return (
      <main className="flex-1">
        <DashboardNav email={user.email ?? "Signed-in user"} />
        <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div
            role="alert"
            className="rounded-xl border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-4 py-3 text-sm text-red-200"
          >
            {result.message}
          </div>
          <Link
            href="/dashboard"
            className="mt-4 inline-block text-sm text-[color:var(--accent)] hover:underline"
          >
            Try again
          </Link>
        </section>
      </main>
    );
  }

  const {
    organizationName,
    role,
    canWrite,
    monitors,
    monitorCount,
    monitorLimit,
  } = result.data;
  const atLimit = monitorCount >= monitorLimit;

  return (
    <main className="flex-1">
      <DashboardNav
        email={user.email ?? "Signed-in user"}
        organizationName={organizationName}
        role={role}
      />

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {params.deleted === "1" && (
          <p
            role="status"
            className="mb-5 rounded-xl border border-[color:var(--accent-dim)] bg-[color:var(--accent)]/10 px-4 py-3 text-sm text-[color:var(--accent)]"
          >
            Monitor deleted.
          </p>
        )}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Monitors
            </h1>
            <p className="mt-1 text-sm text-[color:var(--foreground-muted)]">
              HTTP/HTTPS configuration for {organizationName}.
            </p>
          </div>

          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <p className="text-sm text-[color:var(--foreground-muted)]">
              <span className="font-semibold text-foreground">
                {monitorCount}
              </span>{" "}
              of {monitorLimit} monitors
            </p>
            {canWrite && !atLimit ? (
              <Link
                href="/dashboard/monitors/new"
                className="rounded-lg bg-[color:var(--accent)] px-4 py-2 text-center text-sm font-semibold text-[#0a0e1a] transition-colors hover:bg-[color:var(--accent-dim)]"
              >
                New monitor
              </Link>
            ) : canWrite ? (
              <p className="text-xs text-amber-200">
                Monitor limit reached. Delete a monitor before adding another.
              </p>
            ) : (
              <p className="text-xs text-[color:var(--foreground-muted)]">
                Viewer role: read-only.
              </p>
            )}
          </div>
        </div>

        <div className="mt-5">
          <MonitoringNotice />
        </div>

        {monitors.length < monitorCount && (
          <p className="mt-4 text-xs text-[color:var(--foreground-muted)]">
            Showing the first {monitors.length} of {monitorCount} monitors. This
            list is capped at {MONITOR_LIST_LIMIT} rows.
          </p>
        )}

        {monitors.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-[color:var(--border)] px-6 py-12 text-center">
            <h2 className="text-lg font-semibold">No monitors yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-[color:var(--foreground-muted)]">
              Save an HTTP or HTTPS endpoint to prepare it for the future
              checker. Nothing is checked until the Phase 4 worker exists.
            </p>
            {canWrite && !atLimit && (
              <Link
                href="/dashboard/monitors/new"
                className="mt-5 inline-block rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)]"
              >
                Create your first monitor
              </Link>
            )}
          </div>
        ) : (
          <MonitorList monitors={monitors} canWrite={canWrite} />
        )}
      </section>
    </main>
  );
}
