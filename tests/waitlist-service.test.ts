import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "@/lib/env";
import type { RateLimitDecision } from "@/lib/rate-limit";
import {
  createWaitlistInserter,
  submitWaitlist,
  WAITLIST_MESSAGES,
} from "@/lib/waitlist-service";

const allowRateLimit = (): RateLimitDecision => ({
  allowed: true,
  retryAfterMs: 0,
  remaining: 4,
});

describe("submitWaitlist", () => {
  it("normalizes the email and inserts a landing-page row", async () => {
    const insertRow = vi.fn(async () => ({ error: null }));

    const result = await submitWaitlist(
      { email: "  Test@Example.com ", ip: "203.0.113.10" },
      { insertRow, rateLimit: allowRateLimit }
    );

    expect(result).toEqual({
      status: "joined",
      message: WAITLIST_MESSAGES.joined,
    });
    expect(insertRow).toHaveBeenCalledWith({
      email: "test@example.com",
      source: "landing_page",
    });
  });

  it("reports an existing signup without exposing the stored row", async () => {
    const insertRow = vi.fn(async () => ({
      error: { code: "23505" },
    }));

    const result = await submitWaitlist(
      { email: "person@example.com", ip: "203.0.113.11" },
      { insertRow, rateLimit: allowRateLimit }
    );

    expect(result).toEqual({
      status: "already_joined",
      message: WAITLIST_MESSAGES.alreadyJoined,
    });
  });

  it("rejects invalid emails and unsupported sources without inserting", async () => {
    const insertRow = vi.fn(async () => ({ error: null }));

    const invalidEmail = await submitWaitlist(
      { email: "not-an-email", ip: "203.0.113.12" },
      { insertRow, rateLimit: allowRateLimit }
    );
    expect(invalidEmail.status).toBe("invalid_email");
    expect(insertRow).not.toHaveBeenCalled();

    const invalidSource = await submitWaitlist(
      {
        email: "person@example.com",
        source: "admin_panel",
        ip: "203.0.113.12",
      },
      { insertRow, rateLimit: allowRateLimit }
    );
    expect(invalidSource.status).toBe("invalid_source");
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("returns 429-style information when the limit is exceeded", async () => {
    const insertRow = vi.fn(async () => ({ error: null }));

    const result = await submitWaitlist(
      { email: "person@example.com", ip: "203.0.113.13" },
      {
        insertRow,
        rateLimit: () => ({
          allowed: false,
          retryAfterMs: 90_000,
          remaining: 0,
        }),
      }
    );

    expect(result).toMatchObject({
      status: "rate_limited",
      retryAfterSeconds: 90,
      message: WAITLIST_MESSAGES.rateLimited,
    });
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("silently accepts honeypot submissions without inserting", async () => {
    const insertRow = vi.fn(async () => ({ error: null }));

    const result = await submitWaitlist(
      {
        email: "person@example.com",
        website: "https://spam.example",
        ip: "203.0.113.14",
      },
      { insertRow, rateLimit: allowRateLimit }
    );

    expect(result.status).toBe("joined");
    expect(insertRow).not.toHaveBeenCalled();
  });

  it("returns a generic error when the insert fails", async () => {
    const insertRow = vi.fn(async () => ({
      error: { code: "XX000" },
    }));

    const result = await submitWaitlist(
      { email: "person@example.com", ip: "203.0.113.15" },
      { insertRow, rateLimit: allowRateLimit }
    );

    expect(result).toEqual({
      status: "error",
      message: WAITLIST_MESSAGES.failed,
    });
  });

  it("reports unavailability when Supabase is not configured", async () => {
    const insertRow = vi.fn(async () => {
      throw new ConfigurationError("Missing supabase env");
    });

    const result = await submitWaitlist(
      { email: "person@example.com", ip: "203.0.113.16" },
      { insertRow, rateLimit: allowRateLimit }
    );

    expect(result).toEqual({
      status: "unavailable",
      message: WAITLIST_MESSAGES.unavailable,
    });
  });

  it("fails closed when the server-only service role is not configured", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://example.supabase.co"
    );
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const insertRow = createWaitlistInserter();

    await expect(
      insertRow({ email: "person@example.com", source: "landing_page" })
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("hides unexpected insert exceptions behind a generic message", async () => {
    const insertRow = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    const result = await submitWaitlist(
      { email: "person@example.com", ip: "203.0.113.17" },
      { insertRow, rateLimit: allowRateLimit }
    );

    expect(result).toEqual({
      status: "error",
      message: WAITLIST_MESSAGES.failed,
    });
  });
});
