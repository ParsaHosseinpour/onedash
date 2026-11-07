/**
 * Isolated checker child process.
 *
 * The parent worker owns the database pools and lease tokens. This process is
 * started with a deliberately tiny environment and receives only a minimal
 * MonitorCheckConfig over IPC. It never imports the queue or ingestor clients.
 *
 * Only the fixture and locked adapters are invoked here. createRealChecker is
 * never called or wired into the production worker.
 */

import {
  CheckCancelledError,
  CheckerError,
  CheckTimeoutError,
  SAFE_MESSAGES,
} from "./index";
import { createFixtureChecker, createLockedChecker } from "./adapter";
import { parseMonitorCheckConfig, InvalidCheckerConfigError } from "./config";

const FORBIDDEN_ENV_KEY =
  /^(ONEDASH_|SUPABASE_|DATABASE_URL$|PG[A-Z]|POSTGRES|AWS_|AZURE_|GOOGLE_APPLICATION|GCP_|SERVICE_ROLE|DB_)/i;

function fail(message: string, code = 70): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

for (const key of Object.keys(process.env)) {
  if (FORBIDDEN_ENV_KEY.test(key)) {
    fail("checker_child_rejected_sensitive_environment");
  }
}

type CheckMessage = {
  type: "check";
  executionMode: "fixtures" | "disabled";
  allowedHosts: string[];
  config: unknown;
};

function isCheckMessage(value: unknown): value is CheckMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message).sort();
  if (keys.join(",") !== "allowedHosts,config,executionMode,type") {
    return false;
  }
  return (
    message.type === "check" &&
    (message.executionMode === "fixtures" ||
      message.executionMode === "disabled") &&
    Array.isArray(message.allowedHosts) &&
    message.allowedHosts.every(
      (host) =>
        typeof host === "string" &&
        host.endsWith(".test") &&
        host.length > ".test".length &&
        host !== "localhost" &&
        !host.endsWith(".localhost"),
    )
  );
}

function serializeError(error: unknown): {
  type: "error";
  name: string;
  errorClass: string;
  message: string;
} {
  if (error instanceof CheckCancelledError) {
    return {
      type: "error",
      name: "CheckCancelledError",
      errorClass: "cancelled",
      message: SAFE_MESSAGES.cancelled,
    };
  }
  if (error instanceof CheckTimeoutError) {
    return {
      type: "error",
      name: "CheckTimeoutError",
      errorClass: "timeout",
      message: SAFE_MESSAGES.timeout,
    };
  }
  if (error instanceof CheckerError) {
    return {
      type: "error",
      name: error.name,
      errorClass: error.errorClass,
      message: error.safeMessage,
    };
  }
  return {
    type: "error",
    name: error instanceof Error ? error.name : "Error",
    errorClass: "internal_error",
    message: SAFE_MESSAGES.internal_error,
  };
}

process.on("message", (raw: unknown) => {
  void (async () => {
    try {
      if (!isCheckMessage(raw)) {
        throw new InvalidCheckerConfigError();
      }
      const config = parseMonitorCheckConfig(raw.config);
      const checker =
        raw.executionMode === "fixtures"
          ? createFixtureChecker({ allowedHosts: raw.allowedHosts })
          : createLockedChecker();
      const result = await checker.check(config, new AbortController().signal);
      process.send?.({ type: "result", result }, () => process.exit(0));
    } catch (error) {
      process.send?.(serializeError(error), () => process.exit(0));
    }
  })();
});

process.on("disconnect", () => {
  process.exit(0);
});
