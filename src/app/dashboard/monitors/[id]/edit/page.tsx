import Link from "next/link";
import { notFound } from "next/navigation";
import { updateMonitorAction } from "@/app/actions/monitors";
import { requireUser } from "@/lib/auth";
import { monitorToFormValues } from "@/lib/monitor-config";
import { getMonitorDetail } from "@/lib/monitor-service";
import { createClient } from "@/lib/supabase/server";
import DashboardNav from "../../../DashboardNav";
import MonitorForm from "../../../components/MonitorForm";
import MonitoringNotice from "../../../components/MonitoringNotice";

export const dynamic = "force-dynamic";

export default async function EditMonitorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  const { organizationName, role, canWrite, monitor } = result.data;

  return (
    <main className="flex-1">
      <DashboardNav
        email={user.email ?? "Signed-in user"}
        organizationName={organizationName}
        role={role}
      />

      <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        <Link
          href={`/dashboard/monitors/${monitor.id}`}
          className="text-sm text-[color:var(--accent)] hover:underline"
        >
          ← Back to monitor
        </Link>

        <h1 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
          Edit monitor
        </h1>
        <p className="mt-1 text-sm text-[color:var(--foreground-muted)]">
          Update the saved configuration for {monitor.name}.
        </p>

        <div className="mt-5">
          <MonitoringNotice />
        </div>

        <div className="mt-6">
          {!canWrite ? (
            <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-6">
              <h2 className="font-semibold">Read-only access</h2>
              <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
                Your viewer role cannot edit monitors. Ask an owner, admin, or
                member of this organization to make the change.
              </p>
              <Link
                href={`/dashboard/monitors/${monitor.id}`}
                className="mt-4 inline-block text-sm text-[color:var(--accent)] hover:underline"
              >
                Return to the monitor
              </Link>
            </div>
          ) : (
            <MonitorForm
              action={updateMonitorAction.bind(null, monitor.id)}
              initialValues={monitorToFormValues(monitor)}
              mode="edit"
              cancelHref={`/dashboard/monitors/${monitor.id}`}
            />
          )}
        </div>
      </section>
    </main>
  );
}
