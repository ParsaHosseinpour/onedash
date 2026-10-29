import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MonitorRepositoryError,
  countMonitorRows,
  deleteMonitorRow,
  fetchMonitorLimit,
  findMonitorMembership,
  findMonitorRow,
  insertMonitorRow,
  listMonitorRows,
  updateMonitorActiveRow,
  updateMonitorRow,
} from "@/lib/monitor-repository";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const MONITOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const row = {
  id: MONITOR_ID,
  name: "Production API",
  url: "https://api.example.com/health",
  method: "GET",
  expected_status_codes: [200],
  interval_seconds: 300,
  timeout_seconds: 10,
  is_active: true,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-02T00:00:00.000Z",
};

type QueryResult = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
  count?: number | null;
};

function makeQuery(result: QueryResult) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(async () => result),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.insert.mockReturnValue(query);
  query.update.mockReturnValue(query);
  query.delete.mockReturnValue(query);

  return query;
}

function makeClient(query: ReturnType<typeof makeQuery>): SupabaseClient {
  return { from: vi.fn(() => query) } as unknown as SupabaseClient;
}

const safeColumns =
  "id,name,url,method,expected_status_codes,interval_seconds,timeout_seconds,is_active,created_at,updated_at";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("monitor repository selects", () => {
  it("lists only safe configuration columns", async () => {
    const query = makeQuery({ data: [row], error: null });
    const client = makeClient(query);

    const rows = await listMonitorRows(client, ORGANIZATION_ID);

    expect(query.select).toHaveBeenCalledWith(safeColumns);
    expect(query.select.mock.calls[0][0]).not.toContain("*");
    expect(query.select.mock.calls[0][0]).not.toMatch(
      /header|body|secret|next_run|lease|worker|cipher/i
    );
    expect(query.eq).toHaveBeenCalledWith("organization_id", ORGANIZATION_ID);
    expect(rows[0]).toMatchObject({ id: MONITOR_ID, name: "Production API" });
  });

  it("reads a single monitor with the organization scope", async () => {
    const query = makeQuery({ data: row, error: null });
    const client = makeClient(query);

    await findMonitorRow(client, ORGANIZATION_ID, MONITOR_ID);

    expect(query.select).toHaveBeenCalledWith(safeColumns);
    expect(query.eq).toHaveBeenCalledWith("organization_id", ORGANIZATION_ID);
    expect(query.eq).toHaveBeenCalledWith("id", MONITOR_ID);
  });

  it("inserts only server-derived ownership and configuration fields", async () => {
    const query = makeQuery({ data: row, error: null });
    const client = makeClient(query);

    await insertMonitorRow(client, ORGANIZATION_ID, USER_ID, {
      name: "Production API",
      url: "https://api.example.com/health",
      method: "GET",
      expectedStatusCodes: [200],
      intervalSeconds: 300,
      timeoutSeconds: 10,
      isActive: true,
    });

    expect(query.insert).toHaveBeenCalledWith({
      organization_id: ORGANIZATION_ID,
      created_by: USER_ID,
      name: "Production API",
      url: "https://api.example.com/health",
      method: "GET",
      expected_status_codes: [200],
      interval_seconds: 300,
      timeout_seconds: 10,
      is_active: true,
    });
    expect(query.insert.mock.calls[0][0]).not.toHaveProperty("id");
    expect(query.insert.mock.calls[0][0]).not.toHaveProperty("headers");
    expect(query.insert.mock.calls[0][0]).not.toHaveProperty("body");
  });

  it("updates configuration without changing ownership or state", async () => {
    const query = makeQuery({ data: row, error: null });
    const client = makeClient(query);

    await updateMonitorRow(client, ORGANIZATION_ID, MONITOR_ID, {
      name: "Production API",
      url: "https://api.example.com/health",
      method: "GET",
      expectedStatusCodes: [200],
      intervalSeconds: 300,
      timeoutSeconds: 10,
    });

    const payload = query.update.mock.calls[0][0];
    expect(payload).not.toHaveProperty("organization_id");
    expect(payload).not.toHaveProperty("created_by");
    expect(payload).not.toHaveProperty("is_active");
    expect(query.eq).toHaveBeenCalledWith("organization_id", ORGANIZATION_ID);
    expect(query.eq).toHaveBeenCalledWith("id", MONITOR_ID);
  });

  it("scopes pause/resume and delete to the organization", async () => {
    const activeQuery = makeQuery({ data: row, error: null });
    await updateMonitorActiveRow(
      makeClient(activeQuery),
      ORGANIZATION_ID,
      MONITOR_ID,
      false
    );
    expect(activeQuery.update).toHaveBeenCalledWith({ is_active: false });
    expect(activeQuery.eq).toHaveBeenCalledWith(
      "organization_id",
      ORGANIZATION_ID
    );

    const deleteQuery = makeQuery({ data: { id: MONITOR_ID }, error: null });
    const deleted = await deleteMonitorRow(
      makeClient(deleteQuery),
      ORGANIZATION_ID,
      MONITOR_ID
    );
    expect(deleted).toBe(true);
    expect(deleteQuery.eq).toHaveBeenCalledWith(
      "organization_id",
      ORGANIZATION_ID
    );
  });

  it("counts with an exact head request scoped to the organization", async () => {
    const query = makeQuery({ data: null, error: null, count: 3 });
    const client = makeClient(query);

    await expect(countMonitorRows(client, ORGANIZATION_ID)).resolves.toBe(3);
    expect(query.select).toHaveBeenCalledWith("id", {
      count: "exact",
      head: true,
    });
    expect(query.eq).toHaveBeenCalledWith("organization_id", ORGANIZATION_ID);
  });

  it("resolves membership from the authenticated user's row only", async () => {
    const query = makeQuery({
      data: {
        organization_id: ORGANIZATION_ID,
        role: "owner",
        organizations: { name: "Acme Monitoring" },
      },
      error: null,
    });
    const client = makeClient(query);

    const membership = await findMonitorMembership(client, USER_ID);

    expect(query.select).toHaveBeenCalledWith(
      "organization_id, role, organizations(name)"
    );
    expect(query.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(membership).toEqual({
      organizationId: ORGANIZATION_ID,
      organizationName: "Acme Monitoring",
      role: "owner",
    });
  });
});

describe("monitor repository errors", () => {
  it("classifies the limit trigger error without logging database messages", async () => {
    const query = makeQuery({
      data: null,
      error: { code: "P0001", message: "Monitor limit reached for org secret" },
    });
    const client = makeClient(query);

    await expect(
      insertMonitorRow(client, ORGANIZATION_ID, USER_ID, {
        name: "Production API",
        url: "https://api.example.com/health",
        method: "GET",
        expectedStatusCodes: [200],
        intervalSeconds: 300,
        timeoutSeconds: 10,
        isActive: true,
      })
    ).rejects.toMatchObject({ kind: "limit", code: "P0001" });

    expect(console.error).toHaveBeenCalledWith(
      "Monitor repository operation failed.",
      { operation: "insert_monitor", code: "P0001" }
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "org secret"
    );
  });

  it("classifies forbidden, invalid, and unavailable errors", async () => {
    const cases: Array<[string, string]> = [
      ["42501", "forbidden"],
      ["23514", "invalid"],
      ["23503", "invalid"],
      ["23505", "invalid"],
      ["22P02", "invalid"],
      ["22001", "invalid"],
      ["XX000", "unavailable"],
    ];

    for (const [code, kind] of cases) {
      const query = makeQuery({ data: null, error: { code } });
      const client = makeClient(query);

      await expect(
        findMonitorRow(client, ORGANIZATION_ID, MONITOR_ID)
      ).rejects.toMatchObject({ kind, code });
    }
  });

  it("rejects an unexpected row shape instead of returning it", async () => {
    const query = makeQuery({
      data: { ...row, url: 123 },
      error: null,
    });

    await expect(
      findMonitorRow(makeClient(query), ORGANIZATION_ID, MONITOR_ID)
    ).rejects.toBeInstanceOf(MonitorRepositoryError);
  });
});

describe("fetchMonitorLimit", () => {
  function clientWithLimit(result: QueryResult) {
    return {
      rpc: vi.fn(async () => result),
    } as unknown as SupabaseClient;
  }

  it("returns the database-configured limit", async () => {
    await expect(fetchMonitorLimit(clientWithLimit({ data: 40 }))).resolves.toBe(
      40
    );
    await expect(
      fetchMonitorLimit(clientWithLimit({ data: [40] }))
    ).resolves.toBe(40);
  });

  it("falls back to the documented default without leaking the error", async () => {
    await expect(
      fetchMonitorLimit(
        clientWithLimit({ data: null, error: { code: "42501" } })
      )
    ).resolves.toBe(25);
    await expect(fetchMonitorLimit(clientWithLimit({ data: "40" }))).resolves.toBe(
      25
    );
    expect(console.error).toHaveBeenCalledWith(
      "Monitor limit RPC failed; using the documented fallback.",
      { code: "42501" }
    );
  });
});
