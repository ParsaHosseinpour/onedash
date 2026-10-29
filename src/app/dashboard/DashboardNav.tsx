import Link from "next/link";
import type { OrganizationRole } from "@/lib/monitor-config";
import LogoutButton from "./LogoutButton";

export default function DashboardNav({
  email,
  organizationName,
  role,
}: {
  email: string;
  organizationName?: string;
  role?: OrganizationRole;
}) {
  return (
    <nav
      aria-label="Dashboard"
      className="border-b border-[color:var(--border)]"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/dashboard"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color:var(--accent)] text-sm font-bold text-[#0a0e1a]"
            aria-label="OneDash dashboard"
          >
            1
          </Link>
          <Link href="/dashboard" className="font-semibold tracking-tight">
            OneDash
          </Link>
          <span className="text-xs text-[color:var(--foreground-muted)]">
            Monitor configuration
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 text-xs text-[color:var(--foreground-muted)]">
            {organizationName && (
              <span className="block truncate font-medium text-[color:var(--foreground)]">
                {organizationName}
              </span>
            )}
            <span>
              {role ? `${role} · ${email}` : email}
            </span>
          </div>
          <LogoutButton />
        </div>
      </div>
    </nav>
  );
}
