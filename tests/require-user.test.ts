import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

import { clearSupabaseAuthCookies, requireUser } from "@/lib/auth";
import { ConfigurationError } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

describe("requireUser", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });
  });

  it("returns the authenticated user", async () => {
    const user = { id: "user-1", email: "person@example.com" };
    const client = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user },
          error: null,
        })),
      },
    };
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(requireUser()).resolves.toBe(user);
  });

  it("redirects unauthenticated visitors to /login", async () => {
    const client = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: { message: "no session" },
        })),
      },
    };
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("fails closed when no user is returned", async () => {
    const client = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: null,
        })),
      },
    };
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("redirects to the configuration notice when Supabase is absent", async () => {
    vi.mocked(createClient).mockRejectedValue(
      new ConfigurationError("Missing NEXT_PUBLIC_SUPABASE_URL")
    );

    await expect(requireUser()).rejects.toThrow(
      "NEXT_REDIRECT:/login?error=config"
    );
    expect(redirect).toHaveBeenCalledWith("/login?error=config");
  });

  it("fails closed when session verification throws", async () => {
    const client = {
      auth: {
        getUser: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    };
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(requireUser()).rejects.toThrow(
      "NEXT_REDIRECT:/login?error=session_check_failed"
    );
  });

  it("does not trust a user if getUser also returned an error", async () => {
    const client = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user-1" } },
          error: { message: "token rejected" },
        })),
      },
    };
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});

describe("clearSupabaseAuthCookies", () => {
  it("deletes Supabase auth cookies and leaves unrelated cookies alone", async () => {
    const deleteCookie = vi.fn();
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [
        { name: "sb-project-auth-token", value: "a" },
        { name: "sb-project-auth-token.0", value: "b" },
        { name: "sb-project-auth-token-code-verifier", value: "c" },
        { name: "theme", value: "dark" },
      ],
      delete: deleteCookie,
    } as never);

    await clearSupabaseAuthCookies();

    expect(deleteCookie).toHaveBeenCalledTimes(3);
    expect(deleteCookie).toHaveBeenCalledWith("sb-project-auth-token");
    expect(deleteCookie).toHaveBeenCalledWith("sb-project-auth-token.0");
    expect(deleteCookie).toHaveBeenCalledWith(
      "sb-project-auth-token-code-verifier"
    );
    expect(deleteCookie).not.toHaveBeenCalledWith("theme");
  });
});
