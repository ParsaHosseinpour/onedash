/**
 * Runtime guard for modules that may only be imported by server code.
 *
 * Next.js tree-shakes server-only imports out of client bundles when the
 * `server-only` package is used, but this dependency-free guard is enough to
 * fail loudly if a client component accidentally imports a service-role
 * module. The real security boundary remains: the service-role key is never
 * exposed through a NEXT_PUBLIC_ variable.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "This module is server-only. Do not import it from a client component."
  );
}

export {};
