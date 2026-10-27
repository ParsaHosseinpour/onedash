import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/waitlist/route";
import { submitWaitlist } from "@/lib/waitlist-service";

vi.mock("@/lib/waitlist-service", () => ({
  submitWaitlist: vi.fn(),
}));

const mockedSubmitWaitlist = vi.mocked(submitWaitlist);

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://localhost/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/waitlist", () => {
  beforeEach(() => {
    mockedSubmitWaitlist.mockReset();
  });

  it("returns 200 for a new signup and passes the client IP", async () => {
    mockedSubmitWaitlist.mockResolvedValue({
      status: "joined",
      message: "You're on the list!",
    });

    const response = await POST(
      makeRequest(
        { email: "person@example.com" },
        { "x-forwarded-for": "198.51.100.7, 10.0.0.1" }
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      alreadyJoined: false,
    });
    expect(mockedSubmitWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "person@example.com",
        ip: "198.51.100.7",
      })
    );
  });

  it("returns 200 with alreadyJoined for duplicates", async () => {
    mockedSubmitWaitlist.mockResolvedValue({
      status: "already_joined",
      message: "You're already on the waitlist.",
    });

    const response = await POST(
      makeRequest({ email: "person@example.com" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      alreadyJoined: true,
    });
  });

  it("returns 400 for invalid input", async () => {
    mockedSubmitWaitlist.mockResolvedValue({
      status: "invalid_email",
      message: "Enter a valid email address.",
    });

    const response = await POST(makeRequest({ email: "nope" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    mockedSubmitWaitlist.mockResolvedValue({
      status: "rate_limited",
      message: "Too many attempts.",
      retryAfterSeconds: 120,
    });

    const response = await POST(
      makeRequest({ email: "person@example.com" })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
  });

  it("returns 503 when Supabase is not configured", async () => {
    mockedSubmitWaitlist.mockResolvedValue({
      status: "unavailable",
      message: "Temporarily unavailable.",
    });

    const response = await POST(
      makeRequest({ email: "person@example.com" })
    );

    expect(response.status).toBe(503);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );

    expect(response.status).toBe(400);
    expect(mockedSubmitWaitlist).not.toHaveBeenCalled();
  });
});
