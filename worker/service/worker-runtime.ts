import { CheckCancelledError, CheckTimeoutError } from "../checker";
import type { WorkerChecker } from "../checker/adapter";
import { toMonitorCheckConfig } from "../checker/config";
import type { WorkerConfig } from "../config";
import type {
  IngestCheckResult,
} from "../ingestor/result-payload";
import { toIngestPayload } from "../ingestor/result-payload";
import type { IngestResult } from "../ingestor/ingestor-client";
import {
  classifyError,
  jobFailureDisposition,
  sanitizeReason,
  type Logger,
} from "../logging";
import { sleep } from "../sleep";
import type {
  ClaimJobsInput,
  ClaimResult,
  ClaimedJob,
  ExecutionStatus,
  FailResult,
  HeartbeatDetails,
  JobErrorClass,
  QueueMetrics,
  ReapResult,
  ReleaseResult,
} from "../queue/queue-client";

export interface WorkerQueue {
  claimJobs(input: ClaimJobsInput): Promise<ClaimResult>;
  extendLease(
    jobId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  releaseJob(jobId: string, leaseToken: string): Promise<ReleaseResult>;
  failJob(
    jobId: string,
    leaseToken: string,
    errorClass: JobErrorClass,
    retryable: boolean,
  ): Promise<FailResult>;
  reapExpiredLeases(limit: number): Promise<ReapResult>;
  recordHeartbeat(
    component: "scheduler" | "worker",
    instanceId: string,
    region: string,
    details: HeartbeatDetails,
  ): Promise<void>;
  getExecutionStatus(): Promise<ExecutionStatus>;
  getMetrics(): Promise<QueueMetrics>;
  ping(): Promise<void>;
}

export interface WorkerIngestor {
  ingest(
    jobId: string,
    leaseToken: string,
    result: IngestCheckResult,
  ): Promise<IngestResult>;
  ping(): Promise<void>;
}

export type WorkerRuntimeOptions = {
  config: WorkerConfig;
  queue: WorkerQueue;
  ingestor: WorkerIngestor;
  checker: WorkerChecker;
  logger: Logger;
  now?: () => number;
};

export type WorkerRuntimeMetrics = {
  startedAt: string | null;
  executionMode: string;
  dbExecutionMode: string;
  region: string;
  workerId: string;
  inFlight: number;
  concurrency: number;
  claimedTotal: number;
  completedTotal: number;
  failedTotal: number;
  retriedTotal: number;
  releasedTotal: number;
  reapedTotal: number;
  timeoutTotal: number;
  checkDurationCount: number;
  checkDurationSumMs: number;
  checkDurationMaxMs: number;
  lastClaimAt: string | null;
  lastHeartbeatAt: string | null;
  lastHardTimeoutAt: string | null;
  lastErrorClass: string | null;
};

export type WorkerHealth = {
  status: "ok" | "degraded" | "stopping";
  executionMode: string;
  dbExecutionMode: string;
  dbReady: boolean;
  region: string;
  inFlight: number;
  concurrency: number;
  overdueJobs: number;
  lastHardTimeoutAt: string | null;
  startedAt: string | null;
  uptimeSeconds: number;
};

const LEASE_REAP_BATCH = 20;

export class WorkerRuntime {
  private readonly config: WorkerConfig;
  private readonly queue: WorkerQueue;
  private readonly ingestor: WorkerIngestor;
  private readonly checker: WorkerChecker;
  private readonly logger: Logger;
  private readonly now: () => number;

  private startedAtMs: number | null = null;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly jobControllers = new Map<string, AbortController>();
  private readonly jobDeadlines = new Map<string, number>();
  private readonly lateChecks = new Set<string>();

  private lastHeartbeatAtMs = 0;
  private lastReapAtMs = 0;
  private lastClaimAt: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private lastHardTimeoutAtMs: number | null = null;
  private lastDbExecutionMode = "unknown";
  private lastLoggedExecutionMode: string | null = null;
  private dbReady = false;
  private lastErrorClass: string | null = null;

  private claimedTotal = 0;
  private completedTotal = 0;
  private failedTotal = 0;
  private retriedTotal = 0;
  private releasedTotal = 0;
  private reapedTotal = 0;
  private timeoutTotal = 0;

  private checkDurationCount = 0;
  private checkDurationSumMs = 0;
  private checkDurationMaxMs = 0;

  constructor(options: WorkerRuntimeOptions) {
    this.config = options.config;
    this.queue = options.queue;
    this.ingestor = options.ingestor;
    this.checker = options.checker;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.loopPromise) return;
    this.startedAtMs = this.now();
    this.logger.info("worker_started", {
      executionMode: this.config.executionMode,
      region: this.config.region,
      concurrency: this.config.concurrency,
      fixtureHostCount: this.config.fixtureHosts.length,
    });
    this.loopPromise = this.loop();
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const safeReason = sanitizeReason(reason);
    this.logger.info("worker_stopping", {
      reason: safeReason,
      inFlight: this.inFlight.size,
    });

    this.shutdownController.abort();
    for (const controller of this.jobControllers.values()) {
      controller.abort(new CheckCancelledError());
    }

    const graceMs = this.config.shutdownGraceMs;
    if (this.loopPromise) {
      await Promise.race([
        this.loopPromise.catch(() => undefined),
        sleep(graceMs),
      ]);
    }
    await Promise.race([this.waitForIdle(), sleep(graceMs)]);
    this.logger.info("worker_stopped", {
      reason: safeReason,
      inFlight: this.inFlight.size,
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  getHealth(): WorkerHealth {
    const startedAt =
      this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString();
    const overdueJobs = this.countOverdueJobs() + this.lateChecks.size;
    return {
      status: this.stopping
        ? "stopping"
        : overdueJobs > 0
          ? "degraded"
          : "ok",
      executionMode: this.config.executionMode,
      dbExecutionMode: this.lastDbExecutionMode,
      dbReady: this.dbReady,
      region: this.config.region,
      inFlight: this.inFlight.size,
      concurrency: this.config.concurrency,
      overdueJobs,
      lastHardTimeoutAt:
        this.lastHardTimeoutAtMs === null
          ? null
          : new Date(this.lastHardTimeoutAtMs).toISOString(),
      startedAt,
      uptimeSeconds:
        this.startedAtMs === null
          ? 0
          : Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1000)),
    };
  }

  private countOverdueJobs(): number {
    const now = this.now();
    let overdue = 0;
    for (const [jobId, deadline] of this.jobDeadlines) {
      if (now >= deadline && !this.lateChecks.has(jobId)) overdue += 1;
    }
    return overdue;
  }

  getMetrics(): WorkerRuntimeMetrics {
    return {
      startedAt:
        this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
      executionMode: this.config.executionMode,
      dbExecutionMode: this.lastDbExecutionMode,
      region: this.config.region,
      workerId: this.config.workerId,
      inFlight: this.inFlight.size,
      concurrency: this.config.concurrency,
      claimedTotal: this.claimedTotal,
      completedTotal: this.completedTotal,
      failedTotal: this.failedTotal,
      retriedTotal: this.retriedTotal,
      releasedTotal: this.releasedTotal,
      reapedTotal: this.reapedTotal,
      timeoutTotal: this.timeoutTotal,
      checkDurationCount: this.checkDurationCount,
      checkDurationSumMs: this.checkDurationSumMs,
      checkDurationMaxMs: this.checkDurationMaxMs,
      lastClaimAt: this.lastClaimAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHardTimeoutAt:
        this.lastHardTimeoutAtMs === null
          ? null
          : new Date(this.lastHardTimeoutAtMs).toISOString(),
      lastErrorClass: this.lastErrorClass,
    };
  }

  /** One testable scheduler tick. It never throws to the caller's loop. */
  async runOnce(): Promise<void> {
    if (this.stopping || this.config.executionMode === "disabled") return;

    const status = await this.queue.getExecutionStatus();
    this.lastDbExecutionMode = status.mode;
    this.dbReady = true;

    if (status.mode !== this.lastLoggedExecutionMode) {
      this.logger.info("execution_mode_observed", { mode: status.mode });
      this.lastLoggedExecutionMode = status.mode;
    }

    if (!status.enabled || status.mode !== "fixtures") return;

    const free = this.config.concurrency - this.inFlight.size;
    if (free <= 0) return;

    const claim = await this.queue.claimJobs({
      workerId: this.config.workerId,
      region: this.config.region,
      leaseSeconds: this.config.leaseSeconds,
      batchSize: free,
      allowedHosts: this.config.fixtureHosts,
    });
    this.lastClaimAt = new Date(this.now()).toISOString();

    if (this.stopping) {
      for (const job of claim.jobs) {
        await this.releaseSafely(job);
      }
      return;
    }

    const accepted = claim.jobs.slice(0, free);
    const overflow = claim.jobs.slice(free);
    for (const job of accepted) {
      this.claimedTotal += 1;
      this.startJob(job);
    }
    for (const job of overflow) {
      await this.releaseSafely(job);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (this.now() - this.lastHeartbeatAtMs >= this.config.heartbeatIntervalMs) {
          await this.sendHeartbeat();
        }
        if (this.now() - this.lastReapAtMs >= this.config.reapIntervalMs) {
          await this.reapExpiredLeases();
        }
        await this.runOnce();
        this.dbReady = true;
      } catch (error) {
        this.dbReady = false;
        this.recordError(error);
      }
      await sleep(this.config.pollIntervalMs, this.shutdownController.signal);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    await this.queue.recordHeartbeat(
      "worker",
      this.config.workerId,
      this.config.region,
      {
        concurrency: this.config.concurrency,
        in_flight: this.inFlight.size,
        claimed_total: this.claimedTotal,
        completed_total: this.completedTotal,
        failed_total: this.failedTotal,
        retried_total: this.retriedTotal,
        last_error_class: this.lastErrorClass,
      },
    );
    this.lastHeartbeatAtMs = this.now();
    this.lastHeartbeatAt = new Date(this.lastHeartbeatAtMs).toISOString();
  }

  private async reapExpiredLeases(): Promise<void> {
    const result = await this.queue.reapExpiredLeases(LEASE_REAP_BATCH);
    this.reapedTotal += result.recovered + result.deadLettered;
    this.lastReapAtMs = this.now();
    if (result.recovered > 0 || result.deadLettered > 0) {
      this.logger.info("leases_reaped", {
        reaped: result.recovered,
        deadLettered: result.deadLettered,
      });
    }
  }

  private startJob(job: ClaimedJob): void {
    const controller = new AbortController();
    this.jobControllers.set(job.jobId, controller);
    const promise = this.processJob(job, controller)
      .catch((error) => {
        this.recordError(error);
      })
      .finally(() => {
        this.inFlight.delete(job.jobId);
        this.jobControllers.delete(job.jobId);
      });
    this.inFlight.set(job.jobId, promise);
  }

  private async processJob(
    job: ClaimedJob,
    controller: AbortController,
  ): Promise<void> {
    let timedOut = false;
    let leaseLost = false;
    let leaseExtensionInFlight = false;
    let checkSettled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const deadlineMs = Math.max(1000, (job.timeoutSeconds + 5) * 1000);
    const deadlineAt = this.now() + deadlineMs;
    this.jobDeadlines.set(job.jobId, deadlineAt);

    this.logger.info("job_started", {
      jobId: job.jobId,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      region: job.region,
    });

    const leaseTimer = setInterval(
      () => {
        if (
          leaseExtensionInFlight ||
          timedOut ||
          this.stopping ||
          controller.signal.aborted ||
          this.now() >= deadlineAt
        ) {
          return;
        }
        leaseExtensionInFlight = true;
        void this.queue
          .extendLease(job.jobId, job.leaseToken, this.config.leaseSeconds)
          .then((extended) => {
            if (timedOut) return;
            if (extended) return;
            leaseLost = true;
            if (!controller.signal.aborted) {
              controller.abort(new CheckCancelledError());
            }
            this.logger.warn("lease_lost", { jobId: job.jobId });
          })
          .catch((error) => {
            if (timedOut) return;
            leaseLost = true;
            if (!controller.signal.aborted) {
              controller.abort(new CheckCancelledError());
            }
            const classified = classifyError(error);
            this.logger.warn("lease_extension_failed", {
              jobId: job.jobId,
              errorClass: classified.errorClass,
              errorCode: classified.errorCode,
            });
          })
          .finally(() => {
            leaseExtensionInFlight = false;
          });
      },
      Math.max(1000, Math.floor(this.config.leaseSeconds * 500)),
    );
    leaseTimer.unref?.();

    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(
        () => {
          timedOut = true;
          this.lastHardTimeoutAtMs = this.now();
          // The job is settled and failed below, but the checker promise may
          // still be alive because it ignored the abort signal. Keep it visible
          // to readiness until it actually settles. If the checker already
          // settled, this deadline belongs to a slow ingestion/failure path;
          // countOverdueJobs already exposes that through jobDeadlines.
          if (!checkSettled) {
            this.lateChecks.add(job.jobId);
          }
          clearInterval(leaseTimer);
          if (!controller.signal.aborted) {
            controller.abort(new CheckTimeoutError());
          }
          reject(new CheckTimeoutError());
        },
        deadlineMs,
      );
      timeoutTimer.unref?.();
    });

    try {
      if (this.stopping) {
        await this.releaseSafely(job);
        return;
      }

      const checkConfig = toMonitorCheckConfig(job);
      const checkPromise = Promise.resolve().then(() =>
        this.checker.check(checkConfig, controller.signal),
      );
      // A checker may ignore AbortSignal and settle long after the hard
      // deadline. This handler keeps the detached late result from becoming an
      // unhandled rejection; it is never ingested. It also clears the degraded
      // readiness marker once the abandoned checker finally settles.
      void checkPromise
        .catch(() => undefined)
        .finally(() => {
          checkSettled = true;
          this.lateChecks.delete(job.jobId);
        });

      const result = await Promise.race([checkPromise, deadlinePromise]);

      if (timedOut || this.now() >= deadlineAt) {
        throw new CheckTimeoutError();
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new CheckCancelledError();
      }

      const checkDurationMs = result.totalMs;
      this.recordCheckDuration(checkDurationMs);
      if (result.errorClass === "timeout") {
        this.timeoutTotal += 1;
      }

      const payload = toIngestPayload(result);
      const ingest = await this.ingestor.ingest(job.jobId, job.leaseToken, payload);
      if (!ingest.ok) {
        this.logger.warn("ingest_rejected", {
          jobId: job.jobId,
          reason: ingest.reason ?? "unknown",
        });
        return;
      }

      this.completedTotal += 1;
      this.logger.info("job_completed", {
        jobId: job.jobId,
        status: result.status,
        durationMs: checkDurationMs,
        duplicate: ingest.duplicate,
      });
    } catch (error) {
      if (timedOut || error instanceof CheckTimeoutError) {
        timedOut = true;
        this.timeoutTotal += 1;
        await this.failSafely(job, "timeout", true);
        return;
      }

      if (error instanceof CheckCancelledError || controller.signal.aborted) {
        if (this.stopping) {
          await this.releaseSafely(job);
        } else if (leaseLost) {
          this.logger.warn("job_abandoned", {
            jobId: job.jobId,
            reason: "lease_lost",
          });
        } else {
          await this.failSafely(job, "worker_error", true);
        }
        return;
      }

      const classified = classifyError(error);
      const disposition = jobFailureDisposition(error);
      this.lastErrorClass = classified.errorClass;
      this.logger.error("job_failed", {
        jobId: job.jobId,
        errorClass: classified.errorClass,
        errorCode: classified.errorCode,
      });
      await this.failSafely(
        job,
        disposition.errorClass,
        disposition.retryable,
      );
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      clearInterval(leaseTimer);
      this.jobDeadlines.delete(job.jobId);
    }
  }

  private recordCheckDuration(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.checkDurationCount += 1;
    this.checkDurationSumMs += ms;
    if (ms > this.checkDurationMaxMs) this.checkDurationMaxMs = ms;
  }

  private async releaseSafely(job: ClaimedJob): Promise<void> {
    try {
      const result = await this.queue.releaseJob(job.jobId, job.leaseToken);
      if (result.ok) {
        this.releasedTotal += 1;
        this.logger.info("job_released", {
          jobId: job.jobId,
          status: result.status ?? "pending",
        });
      } else {
        this.logger.warn("job_release_rejected", {
          jobId: job.jobId,
          reason: result.reason ?? "unknown",
        });
      }
    } catch (error) {
      this.recordError(error);
    }
  }

  private async failSafely(
    job: ClaimedJob,
    errorClass: JobErrorClass,
    retryable: boolean,
  ): Promise<void> {
    try {
      const result = await this.queue.failJob(
        job.jobId,
        job.leaseToken,
        errorClass,
        retryable,
      );
      if (!result.ok) {
        this.logger.warn("job_failure_rejected", {
          jobId: job.jobId,
          reason: result.reason ?? "unknown",
        });
        return;
      }

      if (result.status === "pending") {
        this.retriedTotal += 1;
        this.logger.info("job_retry_scheduled", {
          jobId: job.jobId,
          errorClass,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          retryAt: result.retryAt,
        });
      } else if (result.status === "dead_letter") {
        this.failedTotal += 1;
        this.logger.error("job_dead_lettered", {
          jobId: job.jobId,
          errorClass,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
        });
      }
    } catch (error) {
      this.recordError(error);
    }
  }

  private recordError(error: unknown): void {
    const classified = classifyError(error);
    this.lastErrorClass = classified.errorClass;
    this.logger.error("worker_error", {
      errorClass: classified.errorClass,
      errorCode: classified.errorCode,
    });
  }
}
