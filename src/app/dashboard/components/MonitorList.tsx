import Link from "next/link";
import {
  formatCheckInterval,
  formatExpectedStatuses,
  formatTimestampUtc,
  type MonitorSummary,
} from "@/lib/monitor-config";
import MonitorRowActions from "./MonitorRowActions";
import MonitorStateBadge from "./MonitorStateBadge";

export default function MonitorList({
  monitors,
  canWrite,
}: {
  monitors: MonitorSummary[];
  canWrite: boolean;
}) {
  return (
    <ul className="mt-8 space-y-4" aria-label="Monitor configurations">
      {monitors.map((monitor) => {
        const lastChecked = formatTimestampUtc(monitor.lastCheckedAt);

        return (
          <li
            key={monitor.id}
            className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-4 sm:p-5"
          >
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/dashboard/monitors/${monitor.id}`}
                    className="font-semibold tracking-tight hover:underline"
                  >
                    {monitor.name}
                  </Link>
                  <MonitorStateBadge isActive={monitor.isActive} />
                </div>

                <p className="break-all font-mono text-xs text-[color:var(--foreground-muted)]">
                  {monitor.url}
                </p>

                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-[color:var(--foreground-muted)]">
                      Method
                    </dt>
                    <dd>{monitor.method}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--foreground-muted)]">
                      Expected
                    </dt>
                    <dd className="break-words">
                      {formatExpectedStatuses(monitor.expectedStatusCodes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--foreground-muted)]">
                      Interval
                    </dt>
                    <dd>{formatCheckInterval(monitor.intervalSeconds)}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--foreground-muted)]">
                      Timeout
                    </dt>
                    <dd>{monitor.timeoutSeconds} sec</dd>
                  </div>
                </dl>

                <p className="text-xs text-[color:var(--foreground-muted)]">
                  Last recorded check:{" "}
                  {lastChecked && monitor.lastCheckedAt ? (
                    <time dateTime={monitor.lastCheckedAt}>{lastChecked}</time>
                  ) : (
                    "No checks recorded"
                  )}
                </p>
              </div>

              <MonitorRowActions
                monitorId={monitor.id}
                monitorName={monitor.name}
                isActive={monitor.isActive}
                canWrite={canWrite}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
