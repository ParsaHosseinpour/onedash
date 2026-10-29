import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMonitorAction,
  deleteMonitorAction,
  setMonitorActiveAction,
  updateMonitorAction,
} from "@/app/actions/monitors";
import {
  MONITOR_SERVICE_MESSAGES,
  createMonitor,
  deleteMonitor,
  setMonitorActive,
  updateMonitor,
} from "@/lib/monitor-service";
import { requireUser } from "@/lib/auth";
import { ConfigurationError } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  initialMonitorDeleteState,
  initialMonitorFormState,
  type MonitorSummary,
} from "@/lib/monitor-config";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/monitor-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/monitor-service")>();
  return {
    ...actual,
    createMonitor: vi.fn(),
    updateMonitor: vi.fn(),
    setMonitorActive: vi.fn(),
    deleteMonitor: vi.fn(),
  };
});

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MONITOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const summary: MonitorSummary = {
  id: MONITOR_ID,
  name: "Production API",
  url: "https://api.example.com/health",
  method: "GET",
  expectedStatusCodes: [200],
  intervalSeconds: 300,
  timeoutSeconds: 10,
  isActive: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  lastCheckedAt: null,
};

function form(values: Record<string, string> = {}): FormData {
  const data = new FormData();
  const defaults: Record<string, string> = {
    name: "Production API",
    url: "https://api.example.com/health",
    method: "GET",
    expectedStatus: "200",
    intervalMinutes: "5",
    timeoutSeconds: "10",
    initialState: "active",
  };

  for (const [key, value] of Object.entries({ ...defaults, ...values })) {
    data.set(key, value);
  }

  return data;
}

beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue({
    id: USER_ID,
    email: "owner@example.com",
  } as never);
  vi.mocked(createClient).mockResolvedValue({} as never);
  vi.mocked(createMonitor).mockResolvedValue({ ok: true, data: summary });
  vi.mocked(updateMonitor).mockResolvedValue({ ok: true, data: summary });
  vi.mocked(setMonitorActive).mockResolvedValue({ ok: true, data: summary });
  vi.mocked(deleteMonitor).mockResolvedValue({
    ok: true,
    data: { id: MONITOR_ID },
  });
});

describe("createMonitorAction", () => {
  it("redirects to the new monitor after a successful create", async () => {
    await expect(
      createMonitorAction(initialMonitorFormState, form())
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(createMonitor).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      expect.objectContaining({ name: "Production API" })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(redirect).toHaveBeenCalledWith(
      `/dashboard/monitors/${MONITOR_ID}?created=1`
    );
  });

  it("returns safe field errors and submitted values", async () => {
    vi.mocked(createMonitor).mockResolvedValue({
      ok: false,
      code: "invalid_input",
      message: "Check the highlighted fields and try again.",
      fieldErrors: { url: "This host is not allowed." },
      values: {
        name: "Production API",
        url: "http://127.0.0.1/health",
        method: "GET",
        expectedStatus: "200",
        intervalMinutes: "5",
        timeoutSeconds: "10",
        initialState: "active",
      },
    });

    const result = await createMonitorAction(
      initialMonitorFormState,
      form({ url: "http://127.0.0.1/health" })
    );

    expect(result.status).toBe("error");
    expect(result.fieldErrors?.url).toBe("This host is not allowed.");
    expect(result.values?.url).toBe("http://127.0.0.1/health");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not call the service when Supabase is not configured", async () => {
    vi.mocked(createClient).mockRejectedValue(
      new ConfigurationError("Missing NEXT_PUBLIC_SUPABASE_URL")
    );

    const result = await createMonitorAction(initialMonitorFormState, form());

    expect(result.status).toBe("error");
    expect(result.message).toBe(MONITOR_SERVICE_MESSAGES.unavailable);
    expect(createMonitor).not.toHaveBeenCalled();
  });

  it("hides unexpected exceptions behind a generic message", async () => {
    vi.mocked(createMonitor).mockRejectedValue(
      new Error("connection string postgres://secret")
    );

    const result = await createMonitorAction(initialMonitorFormState, form());

    expect(result.status).toBe("error");
    expect(result.message).toBe(MONITOR_SERVICE_MESSAGES.unavailable);
    expect(JSON.stringify(result)).not.toContain("postgres://secret");
  });

  it("propagates the authentication redirect without touching the database", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      createMonitorAction(initialMonitorFormState, form())
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(createClient).not.toHaveBeenCalled();
    expect(createMonitor).not.toHaveBeenCalled();
  });
});

describe("updateMonitorAction", () => {
  it("rejects a malformed monitor id before calling the service", async () => {
    const result = await updateMonitorAction(
      "not-a-uuid",
      initialMonitorFormState,
      form()
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe(MONITOR_SERVICE_MESSAGES.notFound);
    expect(updateMonitor).not.toHaveBeenCalled();
  });

  it("redirects to the detail page after a successful update", async () => {
    await expect(
      updateMonitorAction(MONITOR_ID, initialMonitorFormState, form())
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(updateMonitor).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      MONITOR_ID,
      expect.objectContaining({ name: "Production API" })
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePath).toHaveBeenCalledWith(
      `/dashboard/monitors/${MONITOR_ID}`
    );
    expect(redirect).toHaveBeenCalledWith(
      `/dashboard/monitors/${MONITOR_ID}?updated=1`
    );
  });

  it("returns not_found from the service", async () => {
    vi.mocked(updateMonitor).mockResolvedValue({
      ok: false,
      code: "not_found",
      message: MONITOR_SERVICE_MESSAGES.notFound,
    });

    const result = await updateMonitorAction(
      MONITOR_ID,
      initialMonitorFormState,
      form()
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe(MONITOR_SERVICE_MESSAGES.notFound);
  });
});

describe("setMonitorActiveAction", () => {
  it("rejects invalid ids and non-boolean states", async () => {
    expect(await setMonitorActiveAction("bad-id", true)).toEqual({
      ok: false,
      message: MONITOR_SERVICE_MESSAGES.notFound,
    });
    expect(
      await setMonitorActiveAction(
        MONITOR_ID,
        "true" as unknown as boolean
      )
    ).toEqual({
      ok: false,
      message: MONITOR_SERVICE_MESSAGES.notFound,
    });
    expect(setMonitorActive).not.toHaveBeenCalled();
  });

  it("pauses with the authenticated user and trusted service path", async () => {
    const result = await setMonitorActiveAction(MONITOR_ID, false);

    expect(setMonitorActive).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      MONITOR_ID,
      false
    );
    expect(result).toEqual({ ok: true, message: "Monitor paused." });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("reports a safe failure from the service", async () => {
    vi.mocked(setMonitorActive).mockResolvedValue({
      ok: false,
      code: "forbidden",
      message: MONITOR_SERVICE_MESSAGES.forbidden,
    });

    const result = await setMonitorActiveAction(MONITOR_ID, true);

    expect(result).toEqual({
      ok: false,
      message: MONITOR_SERVICE_MESSAGES.forbidden,
    });
  });

  it("hides unexpected exceptions", async () => {
    vi.mocked(setMonitorActive).mockRejectedValue(
      new Error("internal database detail")
    );

    const result = await setMonitorActiveAction(MONITOR_ID, true);

    expect(result).toEqual({
      ok: false,
      message: MONITOR_SERVICE_MESSAGES.unavailable,
    });
  });
});

describe("deleteMonitorAction", () => {
  it("rejects a malformed id without reading the form confirmation", async () => {
    const result = await deleteMonitorAction(
      "not-a-uuid",
      initialMonitorDeleteState,
      form({ confirmation: "Production API" })
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe(MONITOR_SERVICE_MESSAGES.notFound);
    expect(deleteMonitor).not.toHaveBeenCalled();
  });

  it("passes the exact typed confirmation to the service", async () => {
    await expect(
      deleteMonitorAction(
        MONITOR_ID,
        initialMonitorDeleteState,
        form({ confirmation: "Production API" })
      )
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(deleteMonitor).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      MONITOR_ID,
      "Production API"
    );
    expect(redirect).toHaveBeenCalledWith("/dashboard?deleted=1");
  });

  it("returns the field error and typed confirmation on a mismatch", async () => {
    vi.mocked(deleteMonitor).mockResolvedValue({
      ok: false,
      code: "invalid_input",
      message: "Type the monitor name exactly to confirm deletion.",
      fieldErrors: {
        confirmation: "The confirmation text does not match the monitor name.",
      },
    });

    const result = await deleteMonitorAction(
      MONITOR_ID,
      initialMonitorDeleteState,
      form({ confirmation: "wrong" })
    );

    expect(result).toEqual({
      status: "error",
      message: "Type the monitor name exactly to confirm deletion.",
      fieldError: "The confirmation text does not match the monitor name.",
      confirmation: "wrong",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not expose unexpected deletion errors", async () => {
    vi.mocked(deleteMonitor).mockRejectedValue(
      new Error("permission denied for table monitors")
    );

    const result = await deleteMonitorAction(
      MONITOR_ID,
      initialMonitorDeleteState,
      form({ confirmation: "Production API" })
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe(MONITOR_SERVICE_MESSAGES.unavailable);
    expect(JSON.stringify(result)).not.toContain("permission denied");
  });
});
