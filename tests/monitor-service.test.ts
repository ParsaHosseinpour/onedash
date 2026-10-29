import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MONITOR_SERVICE_MESSAGES,
  createMonitor,
  deleteMonitor,
  getMonitorDetail,
  getMonitorWorkspace,
  setMonitorActive,
  updateMonitor,
} from "@/lib/monitor-service";
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
  updateMonitorActiveRow,
  updateMonitorRow,
  type MonitorMembership,
  type MonitorRow,
} from "@/lib/monitor-repository";

vi.mock("@/lib/monitor-repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/monitor-repository")>();
  return {
    ...actual,
    findMonitorMembership: vi.fn(),
    listMonitorRows: vi.fn(),
    listMonitorLastCheckedAt: vi.fn(),
    findMonitorLastCheckedAt: vi.fn(),
    countMonitorRows: vi.fn(),
    fetchMonitorLimit: vi.fn(),
    findMonitorRow: vi.fn(),
    insertMonitorRow: vi.fn(),
    updateMonitorRow: vi.fn(),
    updateMonitorActiveRow: vi.fn(),
    deleteMonitorRow: vi.fn(),
  };
});

const supabase = {} as SupabaseClient;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MONITOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";

const ownerMembership: MonitorMembership = {
  organizationId: ORGANIZATION_ID,
  organizationName: "Acme Monitoring",
  role: "owner",
};

const viewerMembership: MonitorMembership = {
  ...ownerMembership,
  role: "viewer",
};

const monitorRow: MonitorRow = {
  id: MONITOR_ID,
  name: "Production API",
  url: "https://api.example.com/health",
  method: "GET",
  expected_status_codes: [200, 204],
  interval_seconds: 300,
  timeout_seconds: 10,
  is_active: true,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-02T00:00:00.000Z",
};

const validInput = {
  name: "Production API",
  url: "https://api.example.com/health",
  method: "GET",
  expectedStatus: "200, 204",
  intervalMinutes: "5",
  timeoutSeconds: "10",
  initialState: "active",
};

function mockMembership(membership: MonitorMembership | null = ownerMembership) {
  vi.mocked(findMonitorMembership).mockResolvedValue(membership);
}

beforeEach(() => {
  mockMembership();
  vi.mocked(listMonitorRows).mockResolvedValue([monitorRow]);
  vi.mocked(listMonitorLastCheckedAt).mockResolvedValue(new Map());
  vi.mocked(findMonitorLastCheckedAt).mockResolvedValue(null);
  vi.mocked(countMonitorRows).mockResolvedValue(0);
  vi.mocked(fetchMonitorLimit).mockResolvedValue(25);
  vi.mocked(findMonitorRow).mockResolvedValue(monitorRow);
  vi.mocked(insertMonitorRow).mockResolvedValue(monitorRow);
  vi.mocked(updateMonitorRow).mockResolvedValue(monitorRow);
  vi.mocked(updateMonitorActiveRow).mockResolvedValue(monitorRow);
  vi.mocked(deleteMonitorRow).mockResolvedValue(true);
});

describe("getMonitorWorkspace", () => {
  it("returns no_organization when the user has no trusted membership", async () => {
    mockMembership(null);

    const result = await getMonitorWorkspace(supabase, USER_ID);

    expect(result).toEqual({
      ok: false,
      code: "no_organization",
      message: MONITOR_SERVICE_MESSAGES.noOrganization,
    });
    expect(listMonitorRows).not.toHaveBeenCalled();
  });

  it("uses the membership organization and reports real check timestamps only", async () => {
    vi.mocked(listMonitorLastCheckedAt).mockResolvedValue(
      new Map([[MONITOR_ID, "2026-10-28T10:00:00.000Z"]])
    );
    vi.mocked(countMonitorRows).mockResolvedValue(3);
    vi.mocked(fetchMonitorLimit).mockResolvedValue(25);

    const result = await getMonitorWorkspace(supabase, USER_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(listMonitorRows).toHaveBeenCalledWith(supabase, ORGANIZATION_ID);
    expect(result.data).toMatchObject({
      organizationId: ORGANIZATION_ID,
      organizationName: "Acme Monitoring",
      role: "owner",
      canWrite: true,
      monitorCount: 3,
      monitorLimit: 25,
    });
    expect(result.data.monitors[0].lastCheckedAt).toBe(
      "2026-10-28T10:00:00.000Z"
    );
  });

  it("does not synthesize a last-check time when monitor_state has no row", async () => {
    const result = await getMonitorWorkspace(supabase, USER_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.monitors[0].lastCheckedAt).toBeNull();
  });

  it("marks viewers read-only", async () => {
    mockMembership(viewerMembership);

    const result = await getMonitorWorkspace(supabase, USER_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.canWrite).toBe(false);
  });

  it("maps database errors to a generic unavailable message", async () => {
    vi.mocked(listMonitorRows).mockRejectedValue(
      new MonitorRepositoryError("unavailable", "XX000")
    );

    const result = await getMonitorWorkspace(supabase, USER_ID);

    expect(result).toEqual({
      ok: false,
      code: "unavailable",
      message: MONITOR_SERVICE_MESSAGES.unavailable,
    });
  });
});

describe("getMonitorDetail", () => {
  it("returns not_found for a malformed id without querying the database", async () => {
    const result = await getMonitorDetail(supabase, USER_ID, "not-a-uuid");

    expect(result).toEqual({
      ok: false,
      code: "not_found",
      message: MONITOR_SERVICE_MESSAGES.notFound,
    });
    expect(findMonitorMembership).not.toHaveBeenCalled();
    expect(findMonitorRow).not.toHaveBeenCalled();
  });

  it("returns not_found for a monitor outside the trusted organization", async () => {
    vi.mocked(findMonitorRow).mockResolvedValue(null);

    const result = await getMonitorDetail(supabase, USER_ID, MONITOR_ID);

    expect(result).toEqual({
      ok: false,
      code: "not_found",
      message: MONITOR_SERVICE_MESSAGES.notFound,
    });
    expect(findMonitorRow).toHaveBeenCalledWith(
      supabase,
      ORGANIZATION_ID,
      MONITOR_ID
    );
  });

  it("returns only safe summary fields", async () => {
    const result = await getMonitorDetail(supabase, USER_ID, MONITOR_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.data.monitor).sort()).toEqual(
      [
        "createdAt",
        "expectedStatusCodes",
        "id",
        "intervalSeconds",
        "isActive",
        "lastCheckedAt",
        "method",
        "name",
        "timeoutSeconds",
        "updatedAt",
        "url",
      ].sort()
    );
    expect(JSON.stringify(result.data)).not.toMatch(
      /secret|authorization|ciphertext|next_run|lease|worker/i
    );
  });
});

describe("createMonitor", () => {
  it("rejects viewers before validation or any insert", async () => {
    mockMembership(viewerMembership);

    const result = await createMonitor(supabase, USER_ID, validInput);

    expect(result).toEqual({
      ok: false,
      code: "forbidden",
      message: MONITOR_SERVICE_MESSAGES.viewer,
    });
    expect(insertMonitorRow).not.toHaveBeenCalled();
    expect(countMonitorRows).not.toHaveBeenCalled();
  });

  it("rejects invalid input before counting or inserting", async () => {
    const result = await createMonitor(supabase, USER_ID, {
      ...validInput,
      url: "http://127.0.0.1/health",
      expectedStatus: "200-599",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(result.fieldErrors).toHaveProperty("url");
    expect(result.fieldErrors).toHaveProperty("expectedStatus");
    expect(result.values?.url).toBe("http://127.0.0.1/health");
    expect(countMonitorRows).not.toHaveBeenCalled();
    expect(insertMonitorRow).not.toHaveBeenCalled();
  });

  it("returns the friendly limit message before inserting when at the limit", async () => {
    vi.mocked(countMonitorRows).mockResolvedValue(25);
    vi.mocked(fetchMonitorLimit).mockResolvedValue(25);

    const result = await createMonitor(supabase, USER_ID, validInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("limit_reached");
    expect(result.message).toContain("development limit of 25 monitors");
    expect(insertMonitorRow).not.toHaveBeenCalled();
  });

  it("maps the authoritative database trigger error to the resolved limit", async () => {
    vi.mocked(countMonitorRows).mockResolvedValue(1);
    vi.mocked(fetchMonitorLimit).mockResolvedValue(2);
    vi.mocked(insertMonitorRow).mockRejectedValue(
      new MonitorRepositoryError("limit", "P0001")
    );

    const result = await createMonitor(supabase, USER_ID, validInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("limit_reached");
    expect(result.message).toContain("development limit of 2 monitors");
  });

  it("uses the trusted membership organization and authenticated user", async () => {
    const result = await createMonitor(supabase, USER_ID, validInput);

    expect(result.ok).toBe(true);
    expect(insertMonitorRow).toHaveBeenCalledWith(
      supabase,
      ORGANIZATION_ID,
      USER_ID,
      expect.objectContaining({
        name: "Production API",
        expectedStatusCodes: [200, 204],
        intervalSeconds: 300,
        timeoutSeconds: 10,
        isActive: true,
      })
    );
  });

  it("never trusts an organization id supplied by the browser", async () => {
    // The service signature has no organization parameter. The repository call
    // must use the membership row resolved on the server.
    vi.mocked(findMonitorMembership).mockResolvedValue({
      organizationId: "99999999-9999-4999-8999-999999999999",
      organizationName: "Trusted Org",
      role: "member",
    });

    await createMonitor(supabase, USER_ID, validInput);

    expect(insertMonitorRow).toHaveBeenCalledWith(
      supabase,
      "99999999-9999-4999-8999-999999999999",
      USER_ID,
      expect.anything()
    );
  });

  it("does not expose raw database errors", async () => {
    vi.mocked(insertMonitorRow).mockRejectedValue(
      new MonitorRepositoryError("invalid", "23514")
    );

    const result = await createMonitor(supabase, USER_ID, validInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(MONITOR_SERVICE_MESSAGES.invalidDatabase);
    expect(result.message).not.toMatch(/23514|constraint|monitors_/);
  });

  it("maps unexpected errors to a safe unavailable message", async () => {
    vi.mocked(insertMonitorRow).mockRejectedValue(
      new Error("duplicate key value violates unique constraint: secret")
    );

    const result = await createMonitor(supabase, USER_ID, validInput);

    expect(result).toEqual({
      ok: false,
      code: "unavailable",
      message: MONITOR_SERVICE_MESSAGES.unavailable,
    });
  });
});

describe("updateMonitor", () => {
  it("rejects viewers before reading or writing a monitor", async () => {
    mockMembership(viewerMembership);

    const result = await updateMonitor(supabase, USER_ID, MONITOR_ID, validInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
    expect(updateMonitorRow).not.toHaveBeenCalled();
  });

  it("validates input before updating", async () => {
    const result = await updateMonitor(supabase, USER_ID, MONITOR_ID, {
      ...validInput,
      method: "POST",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(updateMonitorRow).not.toHaveBeenCalled();
  });

  it("returns not_found when the monitor is outside the organization", async () => {
    vi.mocked(updateMonitorRow).mockResolvedValue(null);

    const result = await updateMonitor(supabase, USER_ID, MONITOR_ID, validInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  it("updates using the trusted organization and preserves real check state", async () => {
    vi.mocked(findMonitorLastCheckedAt).mockResolvedValue(
      "2026-10-28T10:00:00.000Z"
    );

    const result = await updateMonitor(supabase, USER_ID, MONITOR_ID, validInput);

    expect(result.ok).toBe(true);
    expect(updateMonitorRow).toHaveBeenCalledWith(
      supabase,
      ORGANIZATION_ID,
      MONITOR_ID,
      expect.objectContaining({ name: "Production API" })
    );
    if (result.ok) {
      expect(result.data.lastCheckedAt).toBe("2026-10-28T10:00:00.000Z");
    }
  });
});

describe("setMonitorActive", () => {
  it("rejects viewers", async () => {
    mockMembership(viewerMembership);

    const result = await setMonitorActive(
      supabase,
      USER_ID,
      MONITOR_ID,
      false
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
    expect(updateMonitorActiveRow).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean state at runtime", async () => {
    const result = await setMonitorActive(
      supabase,
      USER_ID,
      MONITOR_ID,
      "false" as unknown as boolean
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(updateMonitorActiveRow).not.toHaveBeenCalled();
  });

  it("pauses through the trusted organization", async () => {
    vi.mocked(updateMonitorActiveRow).mockResolvedValue({
      ...monitorRow,
      is_active: false,
    });

    const result = await setMonitorActive(
      supabase,
      USER_ID,
      MONITOR_ID,
      false
    );

    expect(result.ok).toBe(true);
    expect(updateMonitorActiveRow).toHaveBeenCalledWith(
      supabase,
      ORGANIZATION_ID,
      MONITOR_ID,
      false
    );
    if (result.ok) expect(result.data.isActive).toBe(false);
  });

  it("returns not_found when the update matched no row", async () => {
    vi.mocked(updateMonitorActiveRow).mockResolvedValue(null);

    const result = await setMonitorActive(
      supabase,
      USER_ID,
      MONITOR_ID,
      true
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });
});

describe("deleteMonitor", () => {
  it("rejects viewers before reading the monitor", async () => {
    mockMembership(viewerMembership);

    const result = await deleteMonitor(
      supabase,
      USER_ID,
      MONITOR_ID,
      monitorRow.name
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
    expect(findMonitorRow).not.toHaveBeenCalled();
    expect(deleteMonitorRow).not.toHaveBeenCalled();
  });

  it("requires the exact server-side monitor name", async () => {
    const result = await deleteMonitor(
      supabase,
      USER_ID,
      MONITOR_ID,
      "production api"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(result.fieldErrors).toHaveProperty("confirmation");
    expect(deleteMonitorRow).not.toHaveBeenCalled();
  });

  it("deletes with the trusted organization after exact confirmation", async () => {
    const result = await deleteMonitor(
      supabase,
      USER_ID,
      MONITOR_ID,
      monitorRow.name
    );

    expect(result).toEqual({ ok: true, data: { id: MONITOR_ID } });
    expect(deleteMonitorRow).toHaveBeenCalledWith(
      supabase,
      ORGANIZATION_ID,
      MONITOR_ID
    );
  });

  it("returns not_found when the monitor disappears before deletion", async () => {
    vi.mocked(deleteMonitorRow).mockResolvedValue(false);

    const result = await deleteMonitor(
      supabase,
      USER_ID,
      MONITOR_ID,
      monitorRow.name
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });
});
