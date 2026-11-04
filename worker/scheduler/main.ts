import {
  ConfigurationError,
  loadSchedulerConfig,
} from "../config";
import { classifyError, createJsonLogger } from "../logging";
import { SchedulerClient } from "./scheduler-client";
import { SchedulerRuntime } from "./scheduler-runtime";

async function main(): Promise<void> {
  const config = loadSchedulerConfig();
  const logger = createJsonLogger({ level: config.logLevel });

  const client = new SchedulerClient({
    connectionString: config.schedulerDatabaseUrl,
    ssl: config.dbSsl,
    onPoolError: (error) => {
      const classified = classifyError(error);
      logger.error("scheduler_pool_error", {
        errorClass: classified.errorClass,
        errorCode: classified.errorCode,
      });
    },
  });

  const runtime = new SchedulerRuntime({ config, client, logger });
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime.stop(signal);
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("unhandledRejection", (error) => {
    const classified = classifyError(error);
    logger.error("unhandled_rejection", {
      errorClass: classified.errorClass,
      errorCode: classified.errorCode,
    });
    process.exitCode = 1;
    void shutdown("unhandled_rejection");
  });
  process.on("uncaughtException", (error) => {
    const classified = classifyError(error);
    logger.error("uncaught_exception", {
      errorClass: classified.errorClass,
      errorCode: classified.errorCode,
    });
    process.exitCode = 1;
    void shutdown("uncaught_exception");
  });

  runtime.start();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    // Configuration errors contain environment variable names, never values.
    process.stderr.write(`${error.message}\n`);
  } else {
    const classified = classifyError(error);
    process.stderr.write(`scheduler_start_failed: ${classified.errorClass}\n`);
  }
  process.exitCode = 1;
});
