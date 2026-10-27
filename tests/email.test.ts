import { describe, expect, it } from "vitest";
import { EMAIL_MAX_LENGTH, normalizeEmail } from "@/lib/email";

describe("normalizeEmail", () => {
  it("trims and lower-cases a valid address", () => {
    expect(normalizeEmail("  Test.User+tag@Example.COM  ")).toEqual({
      ok: true,
      value: "test.user+tag@example.com",
    });
  });

  it("rejects empty and non-string input", () => {
    expect(normalizeEmail("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeEmail(null)).toEqual({ ok: false, reason: "empty" });
    expect(normalizeEmail(42)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects malformed addresses", () => {
    expect(normalizeEmail("not-an-email")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(normalizeEmail("two@@example.com")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(normalizeEmail("spaces in@example.com")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects addresses over the maximum length", () => {
    const localPart = "a".repeat(EMAIL_MAX_LENGTH);
    expect(normalizeEmail(`${localPart}@example.com`)).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});
