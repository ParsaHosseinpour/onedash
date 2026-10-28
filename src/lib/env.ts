/**
 * Environment configuration helpers.
 *
 * These functions validate configuration at the point of use instead of at
 * module load. That keeps the static marketing page buildable without
 * Supabase credentials while still failing loudly on auth/database routes.
 */

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type SupabasePublicEnv = {
  url: string;
  anonKey: string;
};

export type SupabaseServiceRoleEnv = {
  url: string;
  serviceRoleKey: string;
};

function requiredValue(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigurationError(
      `Missing ${name}. Add it to .env.local (see .env.example) and restart the app.`
    );
  }
  return trimmed;
}

function parseHttpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid http(s) URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(`${name} must use http or https.`);
  }

  if (url.username || url.password) {
    throw new ConfigurationError(`${name} must not contain credentials.`);
  }

  return url;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Read and validate the public Supabase configuration.
 *
 * This is safe to call in the browser: Next.js inlines the NEXT_PUBLIC_
 * variables at build time. It throws only when the caller actually needs a
 * client, not while a module is being imported.
 */
export function getSupabasePublicEnv(): SupabasePublicEnv {
  const rawUrl = requiredValue(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
  const anonKey = requiredValue(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  const url = parseHttpUrl("NEXT_PUBLIC_SUPABASE_URL", rawUrl);

  return {
    url: withoutTrailingSlash(url.toString()),
    anonKey,
  };
}

/**
 * Read the server-only service-role configuration.
 *
 * The service-role key bypasses RLS. It must only be used in trusted server
 * code (currently the waitlist write path) and must never be prefixed with
 * NEXT_PUBLIC_, logged, returned to a client, or committed to Git.
 */
export function getSupabaseServiceRoleEnv(): SupabaseServiceRoleEnv {
  const rawUrl = requiredValue(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
  const serviceRoleKey = requiredValue(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const url = parseHttpUrl("NEXT_PUBLIC_SUPABASE_URL", rawUrl);

  return {
    url: withoutTrailingSlash(url.toString()),
    serviceRoleKey,
  };
}

/**
 * Non-throwing check used by UI that can safely render a logged-out state
 * when configuration is absent.
 */
export function isSupabaseConfigured(): boolean {
  try {
    getSupabasePublicEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical site origin used for auth email redirects and callback redirects.
 *
 * The production fallback to the request host would be host-header dependent,
 * so production requires an explicit value. Local development defaults to the
 * usual Next.js port.
 */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (configured) {
    const url = parseHttpUrl("NEXT_PUBLIC_SITE_URL", configured);
    return withoutTrailingSlash(url.toString());
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:3000";
  }

  throw new ConfigurationError(
    "Missing NEXT_PUBLIC_SITE_URL. Set it to the canonical public origin (for example https://onedash.example) before deploying."
  );
}
