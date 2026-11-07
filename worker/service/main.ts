import { createProcessChecker } from "../checker/process-client";
import { createLockedChecker } from "../checker/adapter";
import {
  ConfigurationError,
  loadWorkerConfig,
} from "../config";
import { IngestorClient } from "../ingestor/ingestor-client";
import { classifyError, createJsonLogger } from "../logging";
import { QueueClient } from "../queue/queue-client";
import { createHealthServer } from "./health-server";
import { WorkerRuntime } from "./worker-runtime";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createJsonLogger({ level: config.logLevel });

  const queue = new QueueClient({
    connectionString: config.queueDatabaseUrl,
    ssl: config.dbSsl,
    onPoolError: (error) => {
      const classified = classifyError(error);
      logger.error("queue_pool_error", {
        errorClass: classified.errorClass,
        errorCode: classified.errorCode,
      });
    },
  });

  const ingestor = new IngestorClient({
    connectionString: config.ingestorDatabaseUrl,
    ssl: config.dbSsl,
    onPoolError: (error) => {
      const classified = classifyError(error);
      logger.error("ingestor_pool_error", {
        errorClass: classified.errorClass,
        errorCode: classified.errorCode,
      });
    },
  });

  const checker =
    config.executionMode === "fixtures"
      ? createProcessChecker({
          executionMode: "fixtures",
          allowedHosts: config.fixtureHosts,
        })
      : createLockedChecker();

  const runtime = new WorkerRuntime({
    config,
    queue,
    ingestor,
    checker,
    logger,
  });

  const health = createHealthServer({
    host: config.healthHost,
    port: config.healthPort,
    metricsToken: config.metricsToken,
    runtime,
    queue,
    ingestor,
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime.stop(signal);
    } finally {
      await health.close().catch(() => undefined);
      await Promise.allSettled([queue.close(), ingestor.close()]);
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

  try {
    const address = await health.start();
    runtime.start();
    logger.info("worker_listening", {
      port: address.port,
      executionMode: config.executionMode,
      region: config.region,
      concurrency: config.concurrency,
      fixtureHostCount: config.fixtureHosts.length,
    });
  } catch (error) {
    await Promise.allSettled([queue.close(), ingestor.close()]);
    throw error;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    // Configuration errors contain environment variable names, never values.
    process.stderr.write(`${error.message}\n`);
  } else {
    const classified = classifyError(error);
    process.stderr.write(`worker_start_failed: ${classified.errorClass}\n`);
  }
  process.exitCode = 1;
});
