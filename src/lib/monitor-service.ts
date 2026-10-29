import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_MONITOR_LIMIT,
  canWriteMonitors,
  isMonitorId,
  monitorLimitMessage,
  monitorToFormValues,
  type MonitorFieldErrors,
  type MonitorFormValues,
  type MonitorSummary,
  type OrganizationRole,
} from "@/lib/monitor-config";
import {
  MonitorRepositoryError,
  countMonitorRows,
  deleteMonitorRow,
  fetchMonitorLimit,
  findMonitorLastCheckedAt,
  findMonitorMembership,
  findMonitorRow,
  insertMonitorRow,
  listMonitorLastCheckedAt,
  listMonitorRows,
  monitorRowToSummary,
  updateMonitorActiveRow,
  updateMonitorRow,
} from "@/lib/monitor-repository";
import {
  validateMonitorForm,
  type RawMonitorInput,
} from "@/lib/monitor-validation";

/**
 * Authorization and business rules for monitor configuration.
 *
 * The caller supplies the user id obtained from Supabase Auth on the server and
 * a cookie-scoped Supabase client. The organization is always resolved from
 * the user's membership; no organization id, role, ownership flag, or plan
 * limit is accepted from the browser.
 */

export type MonitorServiceFailureCode =
  | "unauthenticated"
  | "no_organization"
  | "forbidden"
  | "not_found"
  | "limit_reached"
  | "invalid_input"
  | "unavailable";

export type MonitorServiceFailure = {
  ok: false;
  code: MonitorServiceFailureCode;
  message: string;
  fieldErrors?: MonitorFieldErrors;
  values?: MonitorFormValues;
};

export type MonitorServiceResult<T> =
  | { ok: true; data: T }
  | MonitorServiceFailure;

export type MonitorWorkspace = {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
  canWrite: boolean;
  monitors: MonitorSummary[];
  monitorCount: number;
  monitorLimit: number;
};

export type MonitorDetail = {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
  canWrite: boolean;
  monitor: MonitorSummary;
  monitorLimit: number;
};

const MESSAGES = {
  unauthenticated: "Your session has expired. Log in again.",
  noOrganization: "No organization is available for this account.",
  forbidden: "You do not have permission to change monitors in this organization.",
  viewer:
    "Viewers can read monitor configuration but cannot create, edit, pause, resume, or delete monitors.",
  notFound: "Monitor not found.",
  invalid: "Check the highlighted fields and try again.",
  invalidDatabase:
    "The monitor could not be saved because it failed a database validation check.",
  unavailable:
    "Monitor storage is temporarily unavailable. Please try again in a moment.",
} as const;

function failure(
  code: MonitorServiceFailureCode,
  message: string,
  extra?: {
    fieldErrors?: MonitorFieldErrors;
    values?: MonitorFormValues;
  }
): MonitorServiceFailure {
  return { ok: false, code, message, ...extra };
}

function repositoryFailure(
  error: unknown,
  limit: number
): MonitorServiceFailure {
  if (error instanceof MonitorRepositoryError) {
    if (error.kind === "limit") {
      return failure("limit_reached", monitorLimitMessage(limit));
    }

    if (error.kind === "forbidden") {
      return failure("forbidden", MESSAGES.forbidden);
    }

    if (error.kind === "invalid") {
      return failure("invalid_input", MESSAGES.invalidDatabase);
    }

    return failure("unavailable", MESSAGES.unavailable);
  }

  // Unexpected errors are logged without request bodies or database messages.
  console.error("Unexpected monitor service failure.", {
    name: error instanceof Error ? error.name : "unknown",
  });
  return failure("unavailable", MESSAGES.unavailable);
}

function writeDenied(role: OrganizationRole): MonitorServiceFailure {
  return failure(
    "forbidden",
    role === "viewer" ? MESSAGES.viewer : MESSAGES.forbidden
  );
}

async function resolveMembership(
  supabase: SupabaseClient,
  userId: string
) {
  return findMonitorMembership(supabase, userId);
}

export async function getMonitorWorkspace(
  supabase: SupabaseClient,
  userId: string
): Promise<MonitorServiceResult<MonitorWorkspace>> {
  try {
    const membership = await resolveMembership(supabase, userId);
    if (!membership) {
      return failure("no_organization", MESSAGES.noOrganization);
    }

    const [rows, lastCheckedByMonitor, monitorCount, monitorLimit] =
      await Promise.all([
        listMonitorRows(supabase, membership.organizationId),
        listMonitorLastCheckedAt(supabase, membership.organizationId),
        countMonitorRows(supabase, membership.organizationId),
        fetchMonitorLimit(supabase),
      ]);

    return {
      ok: true,
      data: {
        organizationId: membership.organizationId,
        organizationName: membership.organizationName,
        role: membership.role,
        canWrite: canWriteMonitors(membership.role),
        monitors: rows.map((row) =>
          monitorRowToSummary(
            row,
            lastCheckedByMonitor.get(row.id) ?? null
          )
        ),
        monitorCount,
        monitorLimit,
      },
    };
  } catch (error) {
    return repositoryFailure(error, DEFAULT_MONITOR_LIMIT);
  }
}

export async function getMonitorDetail(
  supabase: SupabaseClient,
  userId: string,
  monitorId: string
): Promise<MonitorServiceResult<MonitorDetail>> {
  if (!isMonitorId(monitorId)) {
    return failure("not_found", MESSAGES.notFound);
  }

  try {
    const membership = await resolveMembership(supabase, userId);
    if (!membership) {
      return failure("no_organization", MESSAGES.noOrganization);
    }

    const [row, lastCheckedAt, monitorLimit] = await Promise.all([
      findMonitorRow(supabase, membership.organizationId, monitorId),
      findMonitorLastCheckedAt(
        supabase,
        membership.organizationId,
        monitorId
      ),
      fetchMonitorLimit(supabase),
    ]);

    if (!row) {
      return failure("not_found", MESSAGES.notFound);
    }

    return {
      ok: true,
      data: {
        organizationId: membership.organizationId,
        organizationName: membership.organizationName,
        role: membership.role,
        canWrite: canWriteMonitors(membership.role),
        monitor: monitorRowToSummary(row, lastCheckedAt),
        monitorLimit,
      },
    };
  } catch (error) {
    return repositoryFailure(error, DEFAULT_MONITOR_LIMIT);
  }
}

export async function createMonitor(
  supabase: SupabaseClient,
  userId: string,
  raw: RawMonitorInput
): Promise<MonitorServiceResult<MonitorSummary>> {
  let monitorLimit = 25;

  try {
    const membership = await resolveMembership(supabase, userId);
    if (!membership) {
      return failure("no_organization", MESSAGES.noOrganization);
    }

    if (!canWriteMonitors(membership.role)) {
      return writeDenied(membership.role);
    }

    const validation = validateMonitorForm(raw);
    if (!validation.ok) {
      return failure("invalid_input", MESSAGES.invalid, {
        fieldErrors: validation.fieldErrors,
        values: validation.values,
      });
    }

    const [monitorCount, resolvedLimit] = await Promise.all([
      countMonitorRows(supabase, membership.organizationId),
      fetchMonitorLimit(supabase),
    ]);
    monitorLimit = resolvedLimit;

    // Fast, friendly pre-check. The database trigger is the authoritative
    // check and serializes concurrent inserts, so this cannot be bypassed by a
    // race or a direct PostgREST request.
    if (monitorCount >= monitorLimit) {
      return failure("limit_reached", monitorLimitMessage(monitorLimit));
    }

    const row = await insertMonitorRow(
      supabase,
      membership.organizationId,
      userId,
      validation.input
    );

    return {
      ok: true,
      data: monitorRowToSummary(row, null),
    };
  } catch (error) {
    return repositoryFailure(error, monitorLimit);
  }
}

export async function updateMonitor(
  supabase: SupabaseClient,
  userId: string,
  monitorId: string,
  raw: RawMonitorInput
): Promise<MonitorServiceResult<MonitorSummary>> {
  if (!isMonitorId(monitorId)) {
    return failure("not_found", MESSAGES.notFound);
  }

  try {
    const membership = await resolveMembership(supabase, userId);
    if (!membership) {
      return failure("no_organization", MESSAGES.noOrganization);
    }

    if (!canWriteMonitors(membership.role)) {
      return writeDenied(membership.role);
    }

    const validation = validateMonitorForm(raw);
    if (!validation.ok) {
      return failure("invalid_input", MESSAGES.invalid, {
        fieldErrors: validation.fieldErrors,
        values: validation.values,
      });
    }

    const row = await updateMonitorRow(
      supabase,
      membership.organizationId,
      monitorId,
      {
        name: validation.input.name,
        url: validation.input.url,
        method: validation.input.method,
        expectedStatusCodes: validation.input.expectedStatusCodes,
        intervalSeconds: validation.input.intervalSeconds,
        timeoutSeconds: validation.input.timeoutSeconds,
      }
    );

    if (!row) {
      return failure("not_found", MESSAGES.notFound);
    }

    const lastCheckedAt = await findMonitorLastCheckedAt(
      supabase,
      membership.organizationId,
      monitorId
    );

    return {
      ok: true,
      data: monitorRowToSummary(row, lastCheckedAt),
    };
  } catch (error) {
    return repositoryFailure(error, DEFAULT_MONITOR_LIMIT);
  }
}

export async function setMonitorActive(
  supabase: SupabaseClient,
  userId: string,
  monitorId: string,
  isActive: boolean
): Promise<MonitorServiceResult<MonitorSummary>> {
  if (!isMonitorId(monitorId)) {
    return failure("not_found", MESSAGES.notFound);
  }

  try {
    const membership = await resolveMembership(supabase, userId);
    if (!membership) {
      return failure("no_organization", MESSAGES.noOrganization);
    }

    if (!canWriteMonitors(membership.role)) {
      return writeDenied(membership.role);
    }

    if (typeof isActive !== "boolean") {
      return failure("invalid_input", "Choose whether the monitor is active.");
    }

    const row = await updateMonitorActiveRow(
      supabase,
      membership.organizationId,
      monitorId,
      isActive
    );

    if (!row) {
      return failure("not_found", MESSAGES.notFound);
    }

    const lastCheckedAt = await findMonitorLastCheckedAt(
      supabase,
      membership.organizationId,
      monitorId
    );

    return {
      ok: true,
      data: monitorRowToSummary(row, lastCheckedAt),
    };
  } catch (error) {
    return repositoryFailure(error, DEFAULT_MONITOR_LIMIT);
  }
}

export async function deleteMonitor(
  supabase: SupabaseClient,
  userId: string,
  monitorId: string,
  confirmationName: string
): Promise<MonitorServiceResult<{ id: string }>> {
  if (!isMonitorId(monitorId)) {
    return failure("not_found", MESSAGES.notFound);
  }

  try {
    const membership = await resolveMembership(supabase, userId);
    if (!membership) {
      return failure("no_organization", MESSAGES.noOrganization);
    }

    if (!canWriteMonitors(membership.role)) {
      return writeDenied(membership.role);
    }

    const existing = await findMonitorRow(
      supabase,
      membership.organizationId,
      monitorId
    );

    if (!existing) {
      return failure("not_found", MESSAGES.notFound);
    }

    if (confirmationName !== existing.name) {
      return failure(
        "invalid_input",
        "Type the monitor name exactly to confirm deletion.",
        {
          fieldErrors: {
            confirmation: "The confirmation text does not match the monitor name.",
          },
          values: monitorToFormValues(
            monitorRowToSummary(existing, null)
          ),
        }
      );
    }

    const deleted = await deleteMonitorRow(
      supabase,
      membership.organizationId,
      monitorId
    );

    if (!deleted) {
      return failure("not_found", MESSAGES.notFound);
    }

    return { ok: true, data: { id: monitorId } };
  } catch (error) {
    return repositoryFailure(error, DEFAULT_MONITOR_LIMIT);
  }
}

export { MESSAGES as MONITOR_SERVICE_MESSAGES };
