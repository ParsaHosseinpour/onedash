import { Pool, type PoolConfig } from "pg";

export type DbPoolOptions = {
  connectionString: string;
  ssl: boolean;
  applicationName: string;
  max?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  onError?: (error: unknown) => void;
};

// Every worker-side connection is bounded. The database also enforces tighter
// timeouts on the cleanup function itself; these values protect every other
// scheduler, queue, ingestor, and health query from a stuck lock or an
// abandoned transaction.
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

export function createDbPool(options: DbPoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout:
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    lock_timeout: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      options.idleInTransactionTimeoutMs ??
      DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
  };

  const pool = new Pool(config);
  pool.on("error", (error) => {
    options.onError?.(error);
  });
  return pool;
}

export function pgErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : null;
}
