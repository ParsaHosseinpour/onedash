import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getSupabasePublicEnv: vi.fn(() => ({
    url: "https://example.supabase.co",
    anonKey: "anon-key",
  })),
}));

import { createServerClient } from "@supabase/ssr";
import { createProxyClient } from "@/lib/supabase/proxy";

type CookieToSet = {
  name: string;
  value: string;
  options?: Record<string, unknown>;
};

describe("createProxyClient", () => {
  beforeEach(() => {
    vi.mocked(createServerClient).mockReset();
  });

  it("returns the latest response after Supabase refreshes cookies", () => {
    let setAll: ((cookies: CookieToSet[]) => void) | undefined;

    vi.mocked(createServerClient).mockImplementation(((
      _url: string,
      _anonKey: string,
      options: { cookies: { setAll: (cookies: CookieToSet[]) => void } }
    ) => {
      setAll = options.cookies.setAll;
      return { auth: { getUser: vi.fn() } };
    }) as never);

    const request = new NextRequest("http://localhost/");
    const client = createProxyClient(request);

    setAll?.([
      {
        name: "sb-project-auth-token",
        value: "refreshed-token",
        options: { path: "/" },
      },
    ]);

    const response = client.getResponse();

    expect(response.cookies.get("sb-project-auth-token")?.value).toBe(
      "refreshed-token"
    );
    expect(request.cookies.get("sb-project-auth-token")?.value).toBe(
      "refreshed-token"
    );
  });
});
