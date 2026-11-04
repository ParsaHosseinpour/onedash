/**
 * Worker and scheduler configuration.
 *
 * Secrets are read from environment variables but are never included in
 * validation errors or logs. The worker has two safe Phase 4B modes:
 *
 *   disabled  - default. It heartbeats but never claims a job.
 *   fixtures  - local .test fixtures only. It requires an explicit fixture
 *               host allowlist and a database allowlist row.
 *
 * "customer" is intentionally rejected. Customer execution remains locked
 * until production egress isolation has been independently verified and the
 * worker hosting model has been implemented in a later phase.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type WorkerExecutionMode = "disabled" | "fixtures";

export type WorkerConfig = {
  executionMode: WorkerExecutionMode;
  queueDatabaseUrl: string;
  ingestorDatabaseUrl: string;
  dbSsl: boolean;
  region: string;
  workerId: string;
  concurrency: number;
  leaseSeconds: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  reapIntervalMs: number;
  shutdownGraceMs: number;
  fixtureHosts: string[];
  healthHost: string;
  healthPort: number;
  metricsToken: string | null;
  logLevel: LogLevel;
};

export type SchedulerConfig = {
  schedulerDatabaseUrl: string;
  dbSsl: boolean;
  schedulerId: string;
  region: string;
  intervalMs: number;
  batchSize: number;
  jitterSeconds: number;
  logLevel: LogLevel;
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

type Env = Record<string, string | undefined>;

function readRequired(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigurationError(`${key} is required`);
  }
  return value;
}

function readOptional(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readInteger(
  env: Env,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigurationError(`${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${key} must be between ${min} and ${max}`);
  }
  return value;
}

function readBoolean(env: Env, key: string, defaultValue: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ConfigurationError(`${key} must be true or false`);
}

function readLogLevel(env: Env): LogLevel {
  const raw = env.ONEDASH_LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return "info";
  if ((LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  throw new ConfigurationError(
    `ONEDASH_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`,
  );
}

function validatePostgresUrl(value: string, key: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("protocol");
    }
  } catch {
    // Do not include the value: it may contain a password.
    throw new ConfigurationError(`${key} must be a PostgreSQL connection URL`);
  }
  return value;
}

export function isValidRegion(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length >= 2 && value.length <= 32;
}

function readRegion(env: Env, key: string, defaultValue: string): string {
  const value = env[key]?.trim().toLowerCase() || defaultValue;
  if (!isValidRegion(value)) {
    throw new ConfigurationError(
      `${key} must be 2-32 lowercase letters, digits, or single hyphens`,
    );
  }
  return value;
}

export function isValidHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
    value,
  );
}

function readFixtureHosts(env: Env): string[] {
  const raw = env.ONEDASH_FIXTURE_HOSTS?.trim();
  if (!raw) return [];
  const hosts = [
    ...new Set(
      raw
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (hosts.length > 20) {
    throw new ConfigurationError("ONEDASH_FIXTURE_HOSTS allows at most 20 hosts");
  }
  for (const host of hosts) {
    if (!isValidHostname(host)) {
      throw new ConfigurationError(
        "ONEDASH_FIXTURE_HOSTS contains an invalid hostname",
      );
    }
  }
  return hosts;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const rawMode = (env.ONEDASH_WORKER_EXECUTION_MODE?.trim().toLowerCase() ||
    "disabled") as string;

  if (rawMode === "customer") {
    throw new ConfigurationError(
      "Customer execution is NOT IMPLEMENTED in Phase 4B. The worker refuses to start in customer mode.",
    );
  }
  if (rawMode !== "disabled" && rawMode !== "fixtures") {
    throw new ConfigurationError(
      "ONEDASH_WORKER_EXECUTION_MODE must be disabled or fixtures",
    );
  }

  const executionMode = rawMode as WorkerExecutionMode;
  const fixtureHosts = readFixtureHosts(env);
  if (executionMode === "fixtures" && fixtureHosts.length === 0) {
    throw new ConfigurationError(
      "ONEDASH_FIXTURE_HOSTS is required in fixtures mode",
    );
  }

  const queueDatabaseUrl = validatePostgresUrl(
    readRequired(env, "ONEDASH_QUEUE_DATABASE_URL"),
    "ONEDASH_QUEUE_DATABASE_URL",
  );
  const ingestorDatabaseUrl = validatePostgresUrl(
    readRequired(env, "ONEDASH_INGESTOR_DATABASE_URL"),
    "ONEDASH_INGESTOR_DATABASE_URL",
  );

  const healthHost = env.ONEDASH_HEALTH_HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(healthHost) && !readOptional(env, "ONEDASH_METRICS_TOKEN")) {
    throw new ConfigurationError(
      "ONEDASH_METRICS_TOKEN is required when ONEDASH_HEALTH_HOST is not loopback",
    );
  }

  const metricsToken = readOptional(env, "ONEDASH_METRICS_TOKEN") ?? null;
  if (metricsToken && metricsToken.length < 16) {
    throw new ConfigurationError(
      "ONEDASH_METRICS_TOKEN must be at least 16 characters",
    );
  }

  return {
    executionMode,
    queueDatabaseUrl,
    ingestorDatabaseUrl,
    dbSsl: readBoolean(env, "ONEDASH_DB_SSL", false),
    region: readRegion(env, "ONEDASH_REGION", "local-1"),
    workerId: env.ONEDASH_WORKER_ID?.trim() || `worker-${process.pid}`,
    concurrency: readInteger(env, "ONEDASH_WORKER_CONCURRENCY", 2, 1, 10),
    leaseSeconds: readInteger(env, "ONEDASH_LEASE_SECONDS", 120, 30, 600),
    pollIntervalMs: readInteger(env, "ONEDASH_POLL_INTERVAL_MS", 1000, 250, 60000),
    heartbeatIntervalMs: readInteger(
      env,
      "ONEDASH_HEARTBEAT_INTERVAL_MS",
      5000,
      1000,
      60000,
    ),
    reapIntervalMs: readInteger(env, "ONEDASH_REAP_INTERVAL_MS", 5000, 1000, 60000),
    shutdownGraceMs: readInteger(
      env,
      "ONEDASH_SHUTDOWN_GRACE_MS",
      15000,
      1000,
      60000,
    ),
    fixtureHosts,
    healthHost,
    healthPort: readInteger(env, "ONEDASH_HEALTH_PORT", 9464, 1, 65535),
    metricsToken,
    logLevel: readLogLevel(env),
  };
}

export function loadSchedulerConfig(env: Env = process.env): SchedulerConfig {
  return {
    schedulerDatabaseUrl: validatePostgresUrl(
      readRequired(env, "ONEDASH_SCHEDULER_DATABASE_URL"),
      "ONEDASH_SCHEDULER_DATABASE_URL",
    ),
    dbSsl: readBoolean(env, "ONEDASH_DB_SSL", false),
    schedulerId: env.ONEDASH_SCHEDULER_ID?.trim() || `scheduler-${process.pid}`,
    region: readRegion(env, "ONEDASH_SCHEDULER_REGION", "global"),
    intervalMs: readInteger(env, "ONEDASH_SCHEDULER_INTERVAL_MS", 5000, 1000, 60000),
    batchSize: readInteger(env, "ONEDASH_SCHEDULER_BATCH_SIZE", 50, 1, 100),
    jitterSeconds: readInteger(env, "ONEDASH_SCHEDULER_JITTER_SECONDS", 10, 0, 30),
    logLevel: readLogLevel(env),
  };
}
