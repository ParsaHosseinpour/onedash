import { Pool, type PoolConfig } from "pg";

export type DbPoolOptions = {
  connectionString: string;
  ssl: boolean;
  applicationName: string;
  max?: number;
  onError?: (error: unknown) => void;
};

export function createDbPool(options: DbPoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
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
