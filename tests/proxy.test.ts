import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/env", () => ({
  isSupabaseConfigured: vi.fn(),
}));

vi.mock("@/lib/supabase/proxy", () => ({
  createProxyClient: vi.fn(),
}));

import { isSupabaseConfigured } from "@/lib/env";
import { createProxyClient } from "@/lib/supabase/proxy";
import { proxy } from "@/proxy";

const request = new NextRequest("http://localhost/");

describe("proxy", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("skips Supabase work when configuration is missing", async () => {
    vi.mocked(isSupabaseConfigured).mockReturnValue(false);

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(createProxyClient).not.toHaveBeenCalled();
  });

  it("refreshes the session when configuration is present", async () => {
    const getUser = vi.fn(async () => ({ data: { user: null }, error: null }));
    vi.mocked(isSupabaseConfigured).mockReturnValue(true);
    vi.mocked(createProxyClient).mockReturnValue({
      supabase: { auth: { getUser } },
      getResponse: () => NextResponse.next(),
    } as never);

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(getUser).toHaveBeenCalledOnce();
  });

  it("does not take the page down if session refresh throws", async () => {
    const getUser = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.mocked(isSupabaseConfigured).mockReturnValue(true);
    vi.mocked(createProxyClient).mockReturnValue({
      supabase: { auth: { getUser } },
      getResponse: () => NextResponse.next(),
    } as never);

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(getUser).toHaveBeenCalledOnce();
  });

  it("does not take the page down if proxy client creation throws", async () => {
    vi.mocked(isSupabaseConfigured).mockReturnValue(true);
    vi.mocked(createProxyClient).mockImplementation(() => {
      throw new Error("bad client configuration");
    });

    const response = await proxy(request);

    expect(response.status).toBe(200);
  });
});
