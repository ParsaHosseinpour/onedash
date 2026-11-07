/**
 * Test probe: reports whether the child process can see parent secrets or
 * non-minimal config fields. The clean result is an "up" result with zero
 * leaked fields; a dirty process returns a valid but different result so the
 * parent test fails without trusting child-provided free-form text.
 */
const FORBIDDEN_ENV_KEY =
  /^(ONEDASH_|SUPABASE_|DATABASE_URL$|PG[A-Z]|POSTGRES|AWS_|AZURE_|GOOGLE_APPLICATION|GCP_|SERVICE_ROLE|DB_)/i;

const CONFIG_FIELDS = new Set([
  "url",
  "method",
  "expectedStatusCodes",
  "timeoutSeconds",
  "verifyTls",
  "followRedirects",
  "maxRedirects",
  "hasRequestSecrets",
]);

type CheckMessage = {
  type: "check";
  executionMode: string;
  allowedHosts: string[];
  config: Record<string, unknown>;
};

function isCheckMessage(value: unknown): value is CheckMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    message.type === "check" &&
    message.config !== null &&
    typeof message.config === "object" &&
    !Array.isArray(message.config)
  );
}

process.on("message", (raw: unknown) => {
  if (!isCheckMessage(raw)) {
    process.exit(2);
  }

  const forbiddenEnv = Object.keys(process.env).filter((key) =>
    FORBIDDEN_ENV_KEY.test(key),
  );
  const extraConfig = Object.keys(raw.config).filter(
    (key) => !CONFIG_FIELDS.has(key),
  );
  const serialized = JSON.stringify(raw);
  const leakedToken =
    /leaseToken|lease_token|jobId|job_id|monitorId|monitor_id|organizationId|organization_id|databaseUrl|database_url|serviceRole|service_role|canary/i.test(
      serialized,
    );
  const leaked = forbiddenEnv.length + extraConfig.length + (leakedToken ? 1 : 0);

  const result =
    leaked === 0
      ? {
          status: "up",
          httpStatus: 200,
          responseTimeMs: 1,
          dnsMs: null,
          connectMs: null,
          tlsMs: null,
          ttfbMs: null,
          totalMs: 1,
          errorClass: null,
          errorMessage: null,
          redirects: 0,
          responseBytes: 0,
          checkedAt: new Date().toISOString(),
        }
      : {
          status: "down",
          httpStatus: null,
          responseTimeMs: 1,
          dnsMs: null,
          connectMs: null,
          tlsMs: null,
          ttfbMs: null,
          totalMs: 1,
          errorClass: "internal_error",
          errorMessage: "The checker encountered an internal error.",
          redirects: 0,
          responseBytes: leaked,
          checkedAt: new Date().toISOString(),
        };

  process.send?.({ type: "result", result }, () => process.exit(0));
});
