import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_MONITOR_LIMIT,
  MONITOR_LIST_LIMIT,
  type MonitorMethod,
  type MonitorSummary,
  type OrganizationRole,
} from "@/lib/monitor-config";

/**
 * Data-access layer for monitor configuration.
 *
 * Every query names its columns explicitly. This is deliberate: the monitors
 * table also contains scheduler/checker settings and a sibling table holds
 * encrypted request secrets. Neither belongs in an application DTO.
 *
 * These helpers accept the cookie-scoped Supabase client. They never use the
 * service-role key; RLS remains the final authorization boundary.
 */

const MONITOR_COLUMNS =
  "id,name,url,method,expected_status_codes,interval_seconds,timeout_seconds,is_active,created_at,updated_at";

const ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
];

export type MonitorRow = {
  id: string;
  name: string;
  url: string;
  method: MonitorMethod;
  expected_status_codes: number[];
  interval_seconds: number;
  timeout_seconds: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type MonitorMembership = {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
};

export type MonitorCreateValues = {
  name: string;
  url: string;
  method: MonitorMethod;
  expectedStatusCodes: number[];
  intervalSeconds: number;
  timeoutSeconds: number;
  isActive: boolean;
};

export type MonitorUpdateValues = Omit<MonitorCreateValues, "isActive">;

export type MonitorRepositoryErrorKind =
  | "limit"
  | "forbidden"
  | "invalid"
  | "unavailable";

export class MonitorRepositoryError extends Error {
  readonly kind: MonitorRepositoryErrorKind;
  readonly code: string | null;

  constructor(kind: MonitorRepositoryErrorKind, code: string | null = null) {
    super("Monitor data access failed.");
    this.name = "MonitorRepositoryError";
    this.kind = kind;
    this.code = code;
  }
}

function classifyError(code: string | null | undefined): MonitorRepositoryErrorKind {
  if (code === "P0001") return "limit";
  if (code === "42501") return "forbidden";
  if (
    code === "23514" ||
    code === "23503" ||
    code === "23505" ||
    code === "22P02" ||
    code === "22001"
  ) {
    return "invalid";
  }

  return "unavailable";
}

function fail(
  operation: string,
  error: { code?: string | null } | null
): never {
  const code = error?.code ?? null;

  // Log the operation and SQLSTATE only. PostgREST messages can echo column
  // values, so they must not be written to application logs or returned.
  console.error("Monitor repository operation failed.", { operation, code });
  throw new MonitorRepositoryError(classifyError(code), code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMonitorMethod(value: unknown): value is MonitorMethod {
  return value === "GET" || value === "HEAD";
}

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (
    typeof value === "string" &&
    (ORGANIZATION_ROLES as readonly string[]).includes(value)
  );
}

function parseMonitorRow(value: unknown): MonitorRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    !isMonitorMethod(value.method) ||
    !Array.isArray(value.expected_status_codes) ||
    !value.expected_status_codes.every((code) => typeof code === "number") ||
    typeof value.interval_seconds !== "number" ||
    typeof value.timeout_seconds !== "number" ||
    typeof value.is_active !== "boolean" ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    console.error("Monitor repository received an unexpected row shape.");
    throw new MonitorRepositoryError("unavailable");
  }

  return {
    id: value.id,
    name: value.name,
    url: value.url,
    method: value.method,
    expected_status_codes: value.expected_status_codes,
    interval_seconds: value.interval_seconds,
    timeout_seconds: value.timeout_seconds,
    is_active: value.is_active,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function embeddedOrganizationName(value: unknown): string | null {
  if (Array.isArray(value)) {
    return value.length === 1 ? embeddedOrganizationName(value[0]) : null;
  }

  if (isRecord(value) && typeof value.name === "string") {
    return value.name;
  }

  return null;
}

export async function findMonitorMembership(
  supabase: SupabaseClient,
  userId: string
): Promise<MonitorMembership | null> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id, role, organizations(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) fail("find_monitor_membership", error);
  if (!data) return null;

  if (
    !isRecord(data) ||
    typeof data.organization_id !== "string" ||
    !isOrganizationRole(data.role)
  ) {
    console.error("Monitor membership row has an unexpected shape.");
    throw new MonitorRepositoryError("unavailable");
  }

  const organizationName =
    embeddedOrganizationName(data.organizations) ?? "Your organization";

  return {
    organizationId: data.organization_id,
    organizationName,
    role: data.role,
  };
}

export async function listMonitorRows(
  supabase: SupabaseClient,
  organizationId: string
): Promise<MonitorRow[]> {
  const { data, error } = await supabase
    .from("monitors")
    .select(MONITOR_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(MONITOR_LIST_LIMIT);

  if (error) fail("list_monitors", error);
  if (!Array.isArray(data)) {
    console.error("Monitor list query returned an unexpected payload.");
    throw new MonitorRepositoryError("unavailable");
  }

  return data.map(parseMonitorRow);
}

/**
 * Returns the last real check timestamp per monitor. A missing monitor_state
 * row (or a null timestamp) means no check has ever been recorded; callers must
 * not substitute the configuration's updated_at.
 */
export async function listMonitorLastCheckedAt(
  supabase: SupabaseClient,
  organizationId: string
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("monitor_state")
    .select("monitor_id,last_checked_at")
    .eq("organization_id", organizationId);

  if (error) fail("list_monitor_state", error);

  const result = new Map<string, string>();
  if (!Array.isArray(data)) return result;

  for (const row of data) {
    if (
      isRecord(row) &&
      typeof row.monitor_id === "string" &&
      typeof row.last_checked_at === "string"
    ) {
      result.set(row.monitor_id, row.last_checked_at);
    }
  }

  return result;
}

export async function findMonitorLastCheckedAt(
  supabase: SupabaseClient,
  organizationId: string,
  monitorId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("monitor_state")
    .select("last_checked_at")
    .eq("organization_id", organizationId)
    .eq("monitor_id", monitorId)
    .maybeSingle();

  if (error) fail("find_monitor_state", error);

  return isRecord(data) && typeof data.last_checked_at === "string"
    ? data.last_checked_at
    : null;
}

export async function countMonitorRows(
  supabase: SupabaseClient,
  organizationId: string
): Promise<number> {
  const { count, error } = await supabase
    .from("monitors")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);

  if (error) fail("count_monitors", error);
  return typeof count === "number" ? count : 0;
}

export async function fetchMonitorLimit(
  supabase: SupabaseClient
): Promise<number> {
  const { data, error } = await supabase.rpc("monitor_limit_per_org");

  // The limit is a display/UX hint. The BEFORE INSERT trigger is the
  // authoritative, concurrency-safe enforcement. A stale/fallback display must
  // never turn into a bypass, so the fallback matches the database default.
  if (error) {
    console.error("Monitor limit RPC failed; using the documented fallback.", {
      code: error.code ?? null,
    });
    return DEFAULT_MONITOR_LIMIT;
  }

  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  return DEFAULT_MONITOR_LIMIT;
}

export async function findMonitorRow(
  supabase: SupabaseClient,
  organizationId: string,
  monitorId: string
): Promise<MonitorRow | null> {
  const { data, error } = await supabase
    .from("monitors")
    .select(MONITOR_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", monitorId)
    .maybeSingle();

  if (error) fail("find_monitor", error);
  return data ? parseMonitorRow(data) : null;
}

export async function insertMonitorRow(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  values: MonitorCreateValues
): Promise<MonitorRow> {
  const { data, error } = await supabase
    .from("monitors")
    .insert({
      organization_id: organizationId,
      created_by: userId,
      name: values.name,
      url: values.url,
      method: values.method,
      expected_status_codes: values.expectedStatusCodes,
      interval_seconds: values.intervalSeconds,
      timeout_seconds: values.timeoutSeconds,
      is_active: values.isActive,
    })
    .select(MONITOR_COLUMNS)
    .maybeSingle();

  if (error) fail("insert_monitor", error);
  if (!data) {
    console.error("Monitor insert returned no row.");
    throw new MonitorRepositoryError("unavailable");
  }

  return parseMonitorRow(data);
}

export async function updateMonitorRow(
  supabase: SupabaseClient,
  organizationId: string,
  monitorId: string,
  values: MonitorUpdateValues
): Promise<MonitorRow | null> {
  const { data, error } = await supabase
    .from("monitors")
    .update({
      name: values.name,
      url: values.url,
      method: values.method,
      expected_status_codes: values.expectedStatusCodes,
      interval_seconds: values.intervalSeconds,
      timeout_seconds: values.timeoutSeconds,
    })
    .eq("organization_id", organizationId)
    .eq("id", monitorId)
    .select(MONITOR_COLUMNS)
    .maybeSingle();

  if (error) fail("update_monitor", error);
  return data ? parseMonitorRow(data) : null;
}

export async function updateMonitorActiveRow(
  supabase: SupabaseClient,
  organizationId: string,
  monitorId: string,
  isActive: boolean
): Promise<MonitorRow | null> {
  const { data, error } = await supabase
    .from("monitors")
    .update({ is_active: isActive })
    .eq("organization_id", organizationId)
    .eq("id", monitorId)
    .select(MONITOR_COLUMNS)
    .maybeSingle();

  if (error) fail("set_monitor_active", error);
  return data ? parseMonitorRow(data) : null;
}

export async function deleteMonitorRow(
  supabase: SupabaseClient,
  organizationId: string,
  monitorId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("monitors")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", monitorId)
    .select("id")
    .maybeSingle();

  if (error) fail("delete_monitor", error);
  return Boolean(data);
}

export function monitorRowToSummary(
  row: MonitorRow,
  lastCheckedAt: string | null
): MonitorSummary {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    expectedStatusCodes: row.expected_status_codes,
    intervalSeconds: row.interval_seconds,
    timeoutSeconds: row.timeout_seconds,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt,
  };
}
