import { MONITORING_INACTIVE_NOTICE } from "@/lib/monitor-config";

export default function MonitoringNotice() {
  return (
    <div
      role="note"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-100"
    >
      <span className="font-medium">Not checking yet. </span>
      {MONITORING_INACTIVE_NOTICE}
    </div>
  );
}
