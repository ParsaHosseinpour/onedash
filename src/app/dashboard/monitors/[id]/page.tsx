import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  formatCheckInterval,
  formatExpectedStatuses,
  formatTimestampUtc,
} from "@/lib/monitor-config";
import { getMonitorDetail } from "@/lib/monitor-service";
import { createClient } from "@/lib/supabase/server";
import DashboardNav from "../../DashboardNav";
import MonitorRowActions from "../../components/MonitorRowActions";
import MonitorStateBadge from "../../components/MonitorStateBadge";
import MonitoringNotice from "../../components/MonitoringNotice";

export const dynamic = "force-dynamic";

export default async function MonitorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; updated?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const supabase = await createClient();
  const result = await getMonitorDetail(supabase, user.id, id);

  if (!result.ok) {
    if (result.code === "not_found") {
      notFound();
    }

    return (
      <main className="flex-1">
        <DashboardNav email={user.email ?? "Signed-in user"} />
        <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div
            role="alert"
            className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {result.message}
          </div>
          <Link
            href="/dashboard"
            className="mt-4 inline-block text-sm text-[color:var(--accent)] hover:underline"
          >
            Back to monitors
          </Link>
        </section>
      </main>
    );
  }

  const {
    organizationName,
    role,
    canWrite,
    monitor,
    monitorLimit,
  } = result.data;
  const lastChecked = formatTimestampUtc(monitor.lastCheckedAt);
  const createdAt = formatTimestampUtc(monitor.createdAt);
  const updatedAt = formatTimestampUtc(monitor.updatedAt);

  return (
    <main className="flex-1">
      <DashboardNav
        email={user.email ?? "Signed-in user"}
        organizationName={organizationName}
        role={role}
      />

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <Link
          href="/dashboard"
          className="text-sm text-[color:var(--accent)] hover:underline"
        >
          ← Back to monitors
        </Link>

        {(query.created === "1" || query.updated === "1") && (
          <p
            role="status"
            className="mt-4 rounded-xl border border-[color:var(--accent-dim)] bg-[color:var(--accent)]/10 px-4 py-3 text-sm text-[color:var(--accent)]"
          >
            {query.created === "1"
              ? "Monitor created. It is saved as configuration only."
              : "Monitor configuration updated."}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-words text-2xl font-bold tracking-tight sm:text-3xl">
                {monitor.name}
              </h1>
              <MonitorStateBadge isActive={monitor.isActive} />
            </div>
            <p className="mt-2 break-all font-mono text-sm text-[color:var(--foreground-muted)]">
              {monitor.url}
            </p>
          </div>

          <MonitorRowActions
            monitorId={monitor.id}
            monitorName={monitor.name}
            isActive={monitor.isActive}
            canWrite={canWrite}
          />
        </div>

        <div className="mt-5">
          <MonitoringNotice />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[2fr_1fr]">
          <section
            aria-labelledby="configuration-heading"
            className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-5 sm:p-6"
          >
            <h2 id="configuration-heading" className="font-semibold">
              Configuration
            </h2>

            <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[color:var(--foreground-muted)]">Method</dt>
                <dd className="mt-0.5 font-medium">{monitor.method}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Expected status
                </dt>
                <dd className="mt-0.5 font-medium">
                  {formatExpectedStatuses(monitor.expectedStatusCodes)}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Interval
                </dt>
                <dd className="mt-0.5 font-medium">
                  {formatCheckInterval(monitor.intervalSeconds)}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Timeout
                </dt>
                <dd className="mt-0.5 font-medium">
                  {monitor.timeoutSeconds} sec
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Created
                </dt>
                <dd className="mt-0.5 font-medium">
                  {createdAt ?? "Unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Updated
                </dt>
                <dd className="mt-0.5 font-medium">
                  {updatedAt ?? "Unknown"}
                </dd>
              </div>
            </dl>

            {!canWrite && (
              <p className="mt-5 text-xs text-[color:var(--foreground-muted)]">
                Your viewer role can read this configuration but cannot change
                it.
              </p>
            )}
          </section>

          <section
            aria-labelledby="state-heading"
            className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-5 sm:p-6"
          >
            <h2 id="state-heading" className="font-semibold">
              Recorded state
            </h2>
            <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
              This release has no checker. A timestamp appears only when stored
              monitor state already contains one (for example, seed data). New
              monitors have no state or check history.
            </p>

            <dl className="mt-4 space-y-4 text-sm">
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Last recorded check
                </dt>
                <dd className="mt-0.5 font-medium">
                  {lastChecked && monitor.lastCheckedAt ? (
                    <time dateTime={monitor.lastCheckedAt}>{lastChecked}</time>
                  ) : (
                    "No checks recorded"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Configuration state
                </dt>
                <dd className="mt-0.5 font-medium">
                  {monitor.isActive ? "Active configuration" : "Paused"}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--foreground-muted)]">
                  Organization limit
                </dt>
                <dd className="mt-0.5 font-medium">
                  {monitorLimit} monitors per organization
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </section>
    </main>
  );
}
