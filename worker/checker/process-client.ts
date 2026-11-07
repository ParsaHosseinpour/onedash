import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  CHECK_ERROR_CLASSES,
  CheckCancelledError,
  CheckTimeoutError,
  CheckerError,
  SAFE_MESSAGES,
  type CheckErrorClass,
  type CheckResult,
  type MonitorCheckConfig,
} from "./index";
import type { WorkerChecker } from "./adapter";
import { parseMonitorCheckConfig } from "./config";
import { parseCheckResult } from "./result-parser";

/**
 * Only non-secret runtime variables are passed to the checker child. In
 * particular, ONEDASH_* database URLs, Supabase keys, PG* variables, cloud
 * credentials, and any application secrets are dropped.
 */
const SAFE_CHILD_ENV_KEYS = [
  "NODE_ENV",
  "TZ",
  "LANG",
  "LC_ALL",
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
] as const;

export function buildCheckerChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safe: Record<string, string> = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe as NodeJS.ProcessEnv;
}

export class CheckerProcessError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("isolated checker process failed");
    this.name = "CheckerProcessError";
    this.code = code;
  }
}

export type ProcessCheckerOptions = {
  executionMode: "fixtures" | "disabled";
  allowedHosts: readonly string[];
  /** Test seam: use a probe child that exercises the same IPC contract. */
  childEntry?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra watchdog after the monitor deadline. Parent runtime kills first. */
  watchdogGraceMs?: number;
  forkImpl?: typeof fork;
};

type CheckerChildMessage =
  | { type: "result"; result: unknown }
  | {
      type: "error";
      name: string;
      errorClass: string;
      message: string;
    };

function isCheckerChildMessage(value: unknown): value is CheckerChildMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.type === "result") return true;
  return (
    message.type === "error" &&
    typeof message.name === "string" &&
    typeof message.errorClass === "string" &&
    typeof message.message === "string"
  );
}

function childEntryPath(override?: string): string {
  if (override) return override;
  const extension = path.extname(__filename);
  return path.join(__dirname, `checker-child${extension}`);
}

function childExecArgv(entry: string): string[] {
  return entry.endsWith(".ts") ? ["--import", "tsx"] : [];
}

export function isFixtureTargetHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (!hostname.endsWith(".test") || hostname.length <= ".test".length) {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  return true;
}

function assertFixtureTarget(
  config: MonitorCheckConfig,
  allowedHosts: readonly string[],
): void {
  let hostname: string;
  try {
    const parsed = new URL(config.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("protocol");
    }
    hostname = parsed.hostname.toLowerCase();
  } catch {
    throw new CheckerError("blocked_target", SAFE_MESSAGES.blocked_target);
  }
  if (!isFixtureTargetHost(hostname) || !allowedHosts.includes(hostname)) {
    throw new CheckerError("blocked_target", SAFE_MESSAGES.blocked_target);
  }
}

function errorFromChild(
  message: Extract<CheckerChildMessage, { type: "error" }>,
): Error {
  if (message.name === "CheckCancelledError") return new CheckCancelledError();
  if (message.name === "CheckTimeoutError") return new CheckTimeoutError();
  if (
    CHECK_ERROR_CLASSES.includes(message.errorClass as CheckErrorClass)
  ) {
    const errorClass = message.errorClass as CheckErrorClass;
    // The IPC boundary is not trusted. Even a rogue child cannot inject raw
    // transport text into an error object that later reaches logs or results.
    return new CheckerError(errorClass, SAFE_MESSAGES[errorClass]);
  }
  return new CheckerProcessError("checker_child_error");
}

/**
 * Runs each check in a fresh child process. The parent never sends a lease
 * token, job ID, monitor ID, database credential, or service-role key. The
 * child is killed on cancellation, deadline expiry, or result.
 */
export function createProcessChecker(
  options: ProcessCheckerOptions,
): WorkerChecker {
  const spawn = options.forkImpl ?? fork;
  const entry = childEntryPath(options.childEntry);
  const env = buildCheckerChildEnv(options.env ?? process.env);
  const watchdogGraceMs = options.watchdogGraceMs ?? 10_000;
  const allowedHosts = [
    ...new Set(options.allowedHosts.map((host) => host.toLowerCase())),
  ];
  if (allowedHosts.length === 0 || !allowedHosts.every(isFixtureTargetHost)) {
    throw new CheckerProcessError("invalid_fixture_host_allowlist");
  }

  return {
    async check(config: MonitorCheckConfig, signal: AbortSignal): Promise<CheckResult> {
      const minimalConfig = parseMonitorCheckConfig(config);
      assertFixtureTarget(minimalConfig, allowedHosts);
      if (signal.aborted) throw new CheckCancelledError();

      return new Promise<CheckResult>((resolve, reject) => {
        let child: ChildProcess | null = null;
        let settled = false;
        let watchdog: NodeJS.Timeout | null = null;

        const cleanup = () => {
          if (watchdog) {
            clearTimeout(watchdog);
            watchdog = null;
          }
          signal.removeEventListener("abort", onAbort);
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        };

        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };

        const onAbort = () => {
          settle(() => reject(signal.reason ?? new CheckCancelledError()));
        };

        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }

        try {
          child = spawn(entry, [], {
            env,
            execArgv: childExecArgv(entry),
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          });
        } catch {
          settle(() => reject(new CheckerProcessError("checker_spawn_failed")));
          return;
        }

        // Cancellation can race with spawn. If the promise already settled,
        // make sure the freshly spawned child is not left running.
        if (settled) {
          child.kill("SIGKILL");
          return;
        }

        child.once("error", () => {
          settle(() => reject(new CheckerProcessError("checker_spawn_failed")));
        });

        child.once("exit", (code, exitSignal) => {
          settle(() =>
            reject(
              new CheckerProcessError(
                code === 0 && exitSignal === null
                  ? "checker_exited_without_result"
                  : "checker_process_exited",
              ),
            ),
          );
        });

        child.on("message", (raw: unknown) => {
          if (!isCheckerChildMessage(raw)) {
            settle(() =>
              reject(new CheckerProcessError("checker_invalid_message")),
            );
            return;
          }

          if (raw.type === "error") {
            settle(() => reject(errorFromChild(raw)));
            return;
          }

          try {
            const result = parseCheckResult(raw.result);
            settle(() => resolve(result));
          } catch {
            settle(() =>
              reject(new CheckerProcessError("checker_invalid_result")),
            );
          }
        });

        watchdog = setTimeout(
          () => {
            settle(() => reject(new CheckTimeoutError()));
          },
          Math.max(1000, (minimalConfig.timeoutSeconds + 5) * 1000 + watchdogGraceMs),
        );
        watchdog.unref?.();

        try {
          child.send?.({
            type: "check",
            executionMode: options.executionMode,
            allowedHosts,
            config: minimalConfig,
          });
        } catch {
          settle(() => reject(new CheckerProcessError("checker_send_failed")));
        }
      });
    },
  };
}
