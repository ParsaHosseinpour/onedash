export default function MonitorStateBadge({
  isActive,
}: {
  isActive: boolean;
}) {
  return (
    <span
      className={
        isActive
          ? "inline-flex items-center rounded-full border border-[color:var(--accent-dim)] bg-[color:var(--accent)]/10 px-2.5 py-0.5 text-xs font-medium text-[color:var(--accent)]"
          : "inline-flex items-center rounded-full border border-[color:var(--border)] bg-[color:var(--background)] px-2.5 py-0.5 text-xs font-medium text-[color:var(--foreground-muted)]"
      }
    >
      {isActive ? "Active config" : "Paused"}
    </span>
  );
}
