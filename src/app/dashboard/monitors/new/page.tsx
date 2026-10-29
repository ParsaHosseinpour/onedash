import Link from "next/link";
import { createMonitorAction } from "@/app/actions/monitors";
import { requireUser } from "@/lib/auth";
import {
  emptyMonitorFormValues,
  monitorLimitMessage,
} from "@/lib/monitor-config";
import { getMonitorWorkspace } from "@/lib/monitor-service";
import { createClient } from "@/lib/supabase/server";
import DashboardNav from "../../DashboardNav";
import MonitorForm from "../../components/MonitorForm";
import MonitoringNotice from "../../components/MonitoringNotice";

export const dynamic = "force-dynamic";

export default async function NewMonitorPage() {
  const user = await requireUser();
  const supabase = await createClient();
  const result = await getMonitorWorkspace(supabase, user.id);

  if (!result.ok) {
    return (
      <main className="flex-1">
        <DashboardNav email={user.email ?? "Signed-in user"} />
        <section className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
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

  const { organizationName, role, canWrite, monitorCount, monitorLimit } =
    result.data;
  const atLimit = monitorCount >= monitorLimit;

  return (
    <main className="flex-1">
      <DashboardNav
        email={user.email ?? "Signed-in user"}
        organizationName={organizationName}
        role={role}
      />

      <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        <Link
          href="/dashboard"
          className="text-sm text-[color:var(--accent)] hover:underline"
        >
          ← Back to monitors
        </Link>

        <h1 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
          New monitor
        </h1>
        <p className="mt-1 text-sm text-[color:var(--foreground-muted)]">
          Save an HTTP or HTTPS endpoint for {organizationName}. Validation runs
          on the server, and the organization monitor limit is enforced by the
          database.
        </p>

        <div className="mt-5">
          <MonitoringNotice />
        </div>

        <div className="mt-6">
          {!canWrite ? (
            <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-6">
              <h2 className="font-semibold">Read-only access</h2>
              <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
                Your viewer role cannot create monitors. Ask an owner, admin, or
                member of this organization to make the change.
              </p>
              <Link
                href="/dashboard"
                className="mt-4 inline-block text-sm text-[color:var(--accent)] hover:underline"
              >
                Return to the monitor list
              </Link>
            </div>
          ) : atLimit ? (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-6">
              <h2 className="font-semibold text-amber-100">
                Monitor limit reached
              </h2>
              <p className="mt-2 text-sm text-amber-100/90">
                {monitorLimitMessage(monitorLimit)} The limit is enforced by the
                database, not only by this page.
              </p>
              <Link
                href="/dashboard"
                className="mt-4 inline-block text-sm text-[color:var(--accent)] hover:underline"
              >
                Delete a monitor
              </Link>
            </div>
          ) : (
            <MonitorForm
              action={createMonitorAction}
              initialValues={emptyMonitorFormValues}
              mode="create"
              cancelHref="/dashboard"
            />
          )}
        </div>
      </section>
    </main>
  );
}
