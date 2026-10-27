import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_LOGIN_PATH,
  sanitizeNextPath,
  validatePassword,
} from "@/lib/auth-validation";

describe("sanitizeNextPath", () => {
  it("allows the dashboard and normalizes harmless variants", () => {
    expect(sanitizeNextPath("/dashboard")).toBe("/dashboard");
    expect(sanitizeNextPath("/dashboard/")).toBe("/dashboard");
    expect(sanitizeNextPath("/dashboard?tab=monitors")).toBe("/dashboard");
  });

  it("falls back to the dashboard for missing or unknown paths", () => {
    expect(sanitizeNextPath(null)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(sanitizeNextPath("")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(sanitizeNextPath("/admin")).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(sanitizeNextPath("dashboard")).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it("rejects absolute, protocol-relative, and encoded redirects", () => {
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "%2F%2Fevil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/dashboard%00",
    ]) {
      expect(sanitizeNextPath(value)).toBe(DEFAULT_POST_LOGIN_PATH);
    }
  });

  it("handles malformed percent encoding without throwing", () => {
    expect(sanitizeNextPath("%E0%A4%A")).toBe(DEFAULT_POST_LOGIN_PATH);
  });
});

describe("validatePassword", () => {
  it("accepts a password with letters, numbers, and enough length", () => {
    expect(validatePassword("correct9horse")).toEqual({ ok: true });
  });

  it("rejects short, long, and low-variety passwords", () => {
    expect(validatePassword("a1")).toMatchObject({ ok: false });
    expect(validatePassword("abcdefgh")).toMatchObject({ ok: false });
    expect(validatePassword("12345678")).toMatchObject({ ok: false });
    expect(validatePassword(`${"a1".repeat(40)}`)).toMatchObject({
      ok: false,
    });
  });
});
