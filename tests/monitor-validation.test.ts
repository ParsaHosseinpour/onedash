import { describe, expect, it } from "vitest";
import {
  MONITOR_MAX_EXPECTED_STATUS_CODES,
  formatCheckInterval,
  formatExpectedStatuses,
  formatTimestampUtc,
  monitorLimitMessage,
  parseExpectedStatusCodes,
} from "@/lib/monitor-config";
import {
  isBlockedHostname,
  parseMonitorFormData,
  validateMonitorForm,
} from "@/lib/monitor-validation";

const valid = {
  name: "Production API",
  url: "https://api.example.com/health",
  method: "GET",
  expectedStatus: "200",
  intervalMinutes: "5",
  timeoutSeconds: "10",
  initialState: "active",
};

function validate(overrides: Partial<typeof valid> = {}) {
  return validateMonitorForm({ ...valid, ...overrides });
}

function expectFieldError(
  result: ReturnType<typeof validateMonitorForm>,
  field: string
) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.fieldErrors).toHaveProperty(field);
}

describe("validateMonitorForm", () => {
  it("accepts a normal public HTTPS configuration and normalizes it", () => {
    const result = validate({ name: "  Production API  ", method: "head" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.input).toEqual({
      name: "Production API",
      url: "https://api.example.com/health",
      method: "HEAD",
      expectedStatusCodes: [200],
      intervalSeconds: 300,
      timeoutSeconds: 10,
      isActive: true,
    });
    expect(result.values.name).toBe("Production API");
  });

  it("accepts a paused initial state", () => {
    const result = validate({ initialState: "paused" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.isActive).toBe(false);
  });

  it("rejects an unsupported initial state", () => {
    expectFieldError(validate({ initialState: "archived" }), "initialState");
  });

  it("rejects an empty or oversized name", () => {
    expectFieldError(validate({ name: "   " }), "name");
    expectFieldError(validate({ name: "a".repeat(121) }), "name");
  });

  it("rejects control characters in the name", () => {
    expectFieldError(validate({ name: "API\u0000monitor" }), "name");
  });

  it("rejects malformed and non-HTTP URLs", () => {
    expectFieldError(validate({ url: "not a url" }), "url");
    expectFieldError(validate({ url: "ftp://example.com/health" }), "url");
    expectFieldError(validate({ url: "javascript:alert(1)" }), "url");
    expectFieldError(validate({ url: "https://" }), "url");
  });

  it("rejects embedded credentials", () => {
    expectFieldError(
      validate({ url: "https://user:password@example.com/health" }),
      "url"
    );
    expectFieldError(validate({ url: "https://user@example.com/health" }), "url");
  });

  it("rejects unsupported ports", () => {
    expectFieldError(validate({ url: "https://example.com:8443/health" }), "url");
    expectFieldError(validate({ url: "http://example.com:8080/health" }), "url");
  });

  it("allows explicit ports 80 and 443", () => {
    expect(validate({ url: "http://example.com:80/health" }).ok).toBe(true);
    expect(validate({ url: "https://example.com:443/health" }).ok).toBe(true);
  });

  it("rejects localhost and obvious private targets at configuration time", () => {
    const blocked = [
      "http://localhost/health",
      "http://app.localhost/health",
      "http://printer.local/health",
      "http://metadata.google.internal/health",
      "http://router.home.arpa/health",
      "http://127.0.0.1/health",
      "http://10.1.2.3/health",
      "http://172.16.0.1/health",
      "http://192.168.1.1/health",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0/health",
      "http://[::1]/health",
      "http://[fc00::1]/health",
      "http://[fe80::1]/health",
    ];

    for (const url of blocked) {
      expectFieldError(validate({ url }), "url");
    }
  });

  it("allows public hostnames and public IP addresses", () => {
    expect(validate({ url: "https://example.com" }).ok).toBe(true);
    expect(validate({ url: "http://93.184.216.34/health" }).ok).toBe(true);
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("8.8.8.8")).toBe(false);
  });

  it("rejects an unsupported method", () => {
    expectFieldError(validate({ method: "POST" }), "method");
    expectFieldError(validate({ method: "DELETE" }), "method");
  });

  it("accepts comma lists and inclusive ranges of expected statuses", () => {
    const list = validate({ expectedStatus: "204, 200, 204" });
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.input.expectedStatusCodes).toEqual([200, 204]);

    const range = validate({ expectedStatus: "200-203" });
    expect(range.ok).toBe(true);
    if (range.ok) {
      expect(range.input.expectedStatusCodes).toEqual([200, 201, 202, 203]);
    }
  });

  it("rejects invalid status codes and ranges", () => {
    expectFieldError(validate({ expectedStatus: "" }), "expectedStatus");
    expectFieldError(validate({ expectedStatus: "abc" }), "expectedStatus");
    expectFieldError(validate({ expectedStatus: "99" }), "expectedStatus");
    expectFieldError(validate({ expectedStatus: "600" }), "expectedStatus");
    expectFieldError(validate({ expectedStatus: "204-200" }), "expectedStatus");
    expectFieldError(validate({ expectedStatus: "200-599" }), "expectedStatus");
  });

  it("rejects more than the maximum number of status codes", () => {
    const codes = Array.from({ length: MONITOR_MAX_EXPECTED_STATUS_CODES + 1 }, (_, i) =>
      String(200 + i)
    );
    expectFieldError(
      validate({ expectedStatus: codes.join(",") }),
      "expectedStatus"
    );
  });

  it("enforces interval and timeout bounds", () => {
    expectFieldError(validate({ intervalMinutes: "0.5" }), "intervalMinutes");
    expectFieldError(validate({ intervalMinutes: "1441" }), "intervalMinutes");
    expectFieldError(validate({ intervalMinutes: "five" }), "intervalMinutes");
    expectFieldError(validate({ timeoutSeconds: "0" }), "timeoutSeconds");
    expectFieldError(validate({ timeoutSeconds: "61" }), "timeoutSeconds");
    expectFieldError(validate({ timeoutSeconds: "1.5" }), "timeoutSeconds");
  });

  it("requires the timeout to be shorter than the interval", () => {
    expectFieldError(
      validate({ intervalMinutes: "1", timeoutSeconds: "60" }),
      "timeoutSeconds"
    );
    expect(
      validate({ intervalMinutes: "1", timeoutSeconds: "59" }).ok
    ).toBe(true);
  });

  it("returns every field error at once for an empty submission", () => {
    const result = validateMonitorForm({
      name: "",
      url: "",
      method: "POST",
      expectedStatus: "",
      intervalMinutes: "",
      timeoutSeconds: "",
      initialState: "unknown",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(
      [
        "expectedStatus",
        "initialState",
        "intervalMinutes",
        "method",
        "name",
        "timeoutSeconds",
        "url",
      ].sort()
    );
  });
});

describe("parseMonitorFormData", () => {
  it("reads the expected form field names", () => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(valid)) {
      formData.set(key, value);
    }

    const result = parseMonitorFormData(formData);
    expect(result.ok).toBe(true);
  });

  it("treats missing fields as invalid instead of throwing", () => {
    const result = parseMonitorFormData(new FormData());
    expect(result.ok).toBe(false);
  });
});

describe("parseExpectedStatusCodes", () => {
  it("sorts and deduplicates codes", () => {
    expect(parseExpectedStatusCodes("404, 200, 404, 301")).toEqual({
      ok: true,
      codes: [200, 301, 404],
    });
  });
});

describe("monitor display helpers", () => {
  it("formats status codes into compact ranges", () => {
    expect(formatExpectedStatuses([200, 201, 202, 204])).toBe("200–202, 204");
    expect(formatExpectedStatuses([])).toBe("None");
  });

  it("formats intervals without inventing check data", () => {
    expect(formatCheckInterval(300)).toBe("5 min");
    expect(formatCheckInterval(3600)).toBe("1 hr");
    expect(formatCheckInterval(7200)).toBe("2 hrs");
    expect(formatCheckInterval(90)).toBe("90 sec");
  });

  it("formats real timestamps in UTC and rejects missing values", () => {
    expect(formatTimestampUtc(null)).toBeNull();
    expect(formatTimestampUtc("not-a-date")).toBeNull();
    expect(formatTimestampUtc("2026-10-28T12:34:00.000Z")).toContain("UTC");
  });

  it("describes the limit without promising plan entitlements", () => {
    expect(monitorLimitMessage(1)).toContain("1 monitor.");
    expect(monitorLimitMessage(25)).toContain("25 monitors");
    expect(monitorLimitMessage(25)).not.toMatch(/plan|billing|upgrade/i);
  });
});
