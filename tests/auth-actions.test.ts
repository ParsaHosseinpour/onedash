import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  clearSupabaseAuthCookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { signInAction, signOutAction, signUpAction } from "@/app/actions/auth";
import { clearSupabaseAuthCookies } from "@/lib/auth";
import {
  initialLoginState,
  initialSignupState,
} from "@/lib/auth-validation";
import { ConfigurationError } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

type FakeAuthError = { code?: string; message?: string } | null;
type FakeAuthResult = {
  data?: { session?: unknown };
  error: FakeAuthError;
};

const noError = async (): Promise<FakeAuthResult> => ({
  error: null,
});

const SIGNUP_ACCEPTED_MESSAGE =
  "If this email can be registered, a confirmation link is on its way. If you already have an account, log in instead.";

function makeClient() {
  return {
    auth: {
      signInWithPassword: vi.fn(noError),
      signUp: vi.fn(noError),
      signOut: vi.fn(noError),
    },
  };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

describe("signInAction", () => {
  beforeEach(() => {
    vi.mocked(redirect).mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it("rejects malformed input before calling Supabase", async () => {
    const result = await signInAction(
      initialLoginState,
      form({ email: "not-an-email", password: "secret" })
    );

    expect(result).toMatchObject({ status: "error" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects oversized passwords before calling Supabase", async () => {
    const result = await signInAction(
      initialLoginState,
      form({ email: "person@example.com", password: "a".repeat(73) })
    );

    expect(result).toMatchObject({ status: "error" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("uses a generic message for invalid credentials", async () => {
    const client = makeClient();
    client.auth.signInWithPassword.mockResolvedValue({
      error: { code: "invalid_credentials" },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await signInAction(
      initialLoginState,
      form({ email: "person@example.com", password: "wrong-password" })
    );

    expect(result).toMatchObject({
      status: "error",
      message: "Invalid email or password.",
    });
  });

  it("tells an unconfirmed user to confirm their email", async () => {
    const client = makeClient();
    client.auth.signInWithPassword.mockResolvedValue({
      error: { code: "email_not_confirmed" },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await signInAction(
      initialLoginState,
      form({ email: "person@example.com", password: "password1" })
    );

    expect(result).toMatchObject({
      status: "error",
      message: /confirm your email/i,
    });
  });

  it("tells rate-limited users to try again later", async () => {
    const client = makeClient();
    client.auth.signInWithPassword.mockResolvedValue({
      error: { code: "over_request_rate_limit" },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await signInAction(
      initialLoginState,
      form({ email: "person@example.com", password: "password1" })
    );

    expect(result).toMatchObject({
      status: "error",
      message: /too many attempts/i,
    });
  });

  it("redirects to an allowlisted path after success", async () => {
    const client = makeClient();
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(
      signInAction(
        initialLoginState,
        form({
          email: "person@example.com",
          password: "password1",
          next: "/dashboard",
        })
      )
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("does not let an attacker choose an external redirect", async () => {
    const client = makeClient();
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(
      signInAction(
        initialLoginState,
        form({
          email: "person@example.com",
          password: "password1",
          next: "//evil.example",
        })
      )
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("returns a friendly message when Supabase is not configured", async () => {
    vi.mocked(createClient).mockRejectedValue(
      new ConfigurationError("Missing NEXT_PUBLIC_SUPABASE_URL")
    );

    const result = await signInAction(
      initialLoginState,
      form({ email: "person@example.com", password: "password1" })
    );

    expect(result).toMatchObject({
      status: "error",
      message: /temporarily unavailable/i,
    });
  });
});

describe("signUpAction", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://onedash.example");
  });

  it("enforces the password policy server-side", async () => {
    const result = await signUpAction(
      initialSignupState,
      form({ email: "person@example.com", password: "short" })
    );

    expect(result).toMatchObject({
      status: "error",
      message: /at least 8 characters/i,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("normalizes the email and uses the canonical callback URL", async () => {
    const client = makeClient();
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await signUpAction(
      initialSignupState,
      form({
        email: "  Person@Example.com ",
        password: "password1",
      })
    );

    expect(result).toEqual({
      status: "success",
      message: SIGNUP_ACCEPTED_MESSAGE,
      email: "person@example.com",
    });
    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "password1",
      options: {
        emailRedirectTo: "https://onedash.example/auth/callback",
      },
    });
  });

  it("returns the same accepted state for an existing account", async () => {
    const client = makeClient();
    client.auth.signUp.mockResolvedValue({
      error: { code: "user_already_exists" },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await signUpAction(
      initialSignupState,
      form({ email: "person@example.com", password: "password1" })
    );

    expect(result).toEqual({
      status: "success",
      message: SIGNUP_ACCEPTED_MESSAGE,
      email: "person@example.com",
    });
  });

  it("redirects immediately when email confirmation is disabled", async () => {
    const client = makeClient();
    client.auth.signUp.mockResolvedValue({
      data: { session: { access_token: "test-session" } },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    await expect(
      signUpAction(
        initialSignupState,
        form({ email: "person@example.com", password: "password1" })
      )
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("returns a friendly message when configuration is missing", async () => {
    vi.mocked(createClient).mockRejectedValue(
      new ConfigurationError("Missing NEXT_PUBLIC_SUPABASE_URL")
    );

    const result = await signUpAction(
      initialSignupState,
      form({ email: "person@example.com", password: "password1" })
    );

    expect(result).toMatchObject({
      status: "error",
      message: /temporarily unavailable/i,
    });
  });
});

describe("signOutAction", () => {
  beforeEach(() => {
    vi.mocked(clearSupabaseAuthCookies).mockResolvedValue(undefined);
  });

  it("signs out and clears cookies", async () => {
    const client = makeClient();
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await signOutAction();

    expect(result).toEqual({ ok: true });
    expect(client.auth.signOut).toHaveBeenCalledOnce();
    expect(clearSupabaseAuthCookies).toHaveBeenCalledOnce();
  });

  it("still clears local cookies when Supabase revocation fails", async () => {
    const client = makeClient();
    client.auth.signOut.mockRejectedValue(new Error("network down"));
    vi.mocked(createClient).mockResolvedValue(client as never);

    const result = await signOutAction();

    expect(result).toEqual({ ok: true });
    expect(clearSupabaseAuthCookies).toHaveBeenCalledOnce();
  });

  it("reports a failure if cookies cannot be cleared", async () => {
    const client = makeClient();
    vi.mocked(createClient).mockResolvedValue(client as never);
    vi.mocked(clearSupabaseAuthCookies).mockRejectedValue(
      new Error("cookie store unavailable")
    );

    const result = await signOutAction();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/couldn't fully log you out/i);
  });
});
