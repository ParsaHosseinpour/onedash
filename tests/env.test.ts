import { describe, expect, it, vi } from "vitest";
import {
  ConfigurationError,
  getSiteUrl,
  getSupabasePublicEnv,
  isSupabaseConfigured,
} from "@/lib/env";

describe("getSupabasePublicEnv", () => {
  it("fails with an actionable message when values are missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    expect(() => getSupabasePublicEnv()).toThrowError(ConfigurationError);
    expect(() => getSupabasePublicEnv()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/
    );
  });

  it("reads, validates, and normalizes configured values", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://example.supabase.co/"
    );
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "  anon-key  ");

    expect(getSupabasePublicEnv()).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
    });
  });

  it("rejects malformed URLs, non-http protocols, and credentials", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-url");
    expect(() => getSupabasePublicEnv()).toThrow(/valid http/);

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "ftp://example.com");
    expect(() => getSupabasePublicEnv()).toThrow(/http or https/);

    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://user:pass@example.com"
    );
    expect(() => getSupabasePublicEnv()).toThrow(/credentials/);
  });
});

describe("isSupabaseConfigured", () => {
  it("returns false when configuration is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns true when configuration is present", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://example.supabase.co"
    );
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");

    expect(isSupabaseConfigured()).toBe(true);
  });
});

describe("getSiteUrl", () => {
  it("normalizes a configured canonical origin", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://onedash.example/");

    expect(getSiteUrl()).toBe("https://onedash.example");
  });

  it("falls back to localhost outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");

    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("requires an explicit origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");

    expect(() => getSiteUrl()).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it("rejects an invalid configured origin", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "javascript:alert(1)");

    expect(() => getSiteUrl()).toThrow(/http or https/);
  });
});
