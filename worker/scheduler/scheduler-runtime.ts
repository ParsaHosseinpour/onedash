import type { SchedulerConfig } from "../config";
import {
  classifyError,
  sanitizeReason,
  type Logger,
} from "../logging";
import type {
  ExecutionStatus,
  HeartbeatDetails,
  QueueMetrics,
  ReapResult,
} from "../queue/queue-client";
import { sleep } from "../sleep";
import type { ScheduleSummary } from "./scheduler-client";

export interface SchedulerClientLike {
  scheduleDueJobs(batchSize: number, jitterSeconds: number): Promise<ScheduleSummary>;
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

export type SchedulerRuntimeOptions = {
  config: SchedulerConfig;
  client: SchedulerClientLike;
  logger: Logger;
  now?: () => number;
};

export type SchedulerRuntimeMetrics = {
  startedAt: string | null;
  dbExecutionMode: string;
  region: string;
  schedulerId: string;
  ticks: number;
  scheduledTotal: number;
  skippedTotal: number;
  reapedTotal: number;
  deadLetteredTotal: number;
  lastTickAt: string | null;
  lastHeartbeatAt: string | null;
  lastErrorClass: string | null;
};

const REAP_BATCH = 20;
const SHUTDOWN_GRACE_MS = 5000;

export class SchedulerRuntime {
  private readonly config: SchedulerConfig;
  private readonly client: SchedulerClientLike;
  private readonly logger: Logger;
  private readonly now: () => number;

  private startedAtMs: number | null = null;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private readonly abortController = new AbortController();

  private lastDbExecutionMode = "unknown";
  private lastLoggedExecutionMode: string | null = null;
  private lastTickAt: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private lastErrorClass: string | null = null;

  private ticks = 0;
  private scheduledTotal = 0;
  private skippedTotal = 0;
  private reapedTotal = 0;
  private deadLetteredTotal = 0;

  constructor(options: SchedulerRuntimeOptions) {
    this.config = options.config;
    this.client = options.client;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.loopPromise) return;
    this.startedAtMs = this.now();
    this.logger.info("scheduler_started", {
      schedulerId: this.config.schedulerId,
      region: this.config.region,
      concurrency: 1,
    });
    this.loopPromise = this.loop();
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const safeReason = sanitizeReason(reason);
    this.logger.info("scheduler_stopping", { reason: safeReason });
    this.abortController.abort();
    if (this.loopPromise) {
      await Promise.race([
        this.loopPromise.catch(() => undefined),
        sleep(SHUTDOWN_GRACE_MS),
      ]);
    }
    this.logger.info("scheduler_stopped", { reason: safeReason });
  }

  getMetrics(): SchedulerRuntimeMetrics {
    return {
      startedAt:
        this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
      dbExecutionMode: this.lastDbExecutionMode,
      region: this.config.region,
      schedulerId: this.config.schedulerId,
      ticks: this.ticks,
      scheduledTotal: this.scheduledTotal,
      skippedTotal: this.skippedTotal,
      reapedTotal: this.reapedTotal,
      deadLetteredTotal: this.deadLetteredTotal,
      lastTickAt: this.lastTickAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastErrorClass: this.lastErrorClass,
    };
  }

  async runOnce(): Promise<void> {
    if (this.stopping) return;

    const status = await this.client.getExecutionStatus();
    this.lastDbExecutionMode = status.mode;

    if (status.mode !== this.lastLoggedExecutionMode) {
      this.logger.info("execution_mode_observed", { mode: status.mode });
      this.lastLoggedExecutionMode = status.mode;
    }

    const reap = await this.client.reapExpiredLeases(REAP_BATCH);
    this.reapedTotal += reap.recovered;
    this.deadLetteredTotal += reap.deadLettered;

    const summary = await this.client.scheduleDueJobs(
      this.config.batchSize,
      this.config.jitterSeconds,
    );
    this.scheduledTotal += summary.scheduled;
    this.skippedTotal += summary.skipped;

    await this.client.recordHeartbeat(
      "scheduler",
      this.config.schedulerId,
      this.config.region,
      {
        batch_size: this.config.batchSize,
        jitter_seconds: this.config.jitterSeconds,
        last_scheduled: summary.scheduled,
        last_skipped: summary.skipped,
        execution_mode: status.mode,
      },
    );

    this.ticks += 1;
    const tickAt = new Date(this.now()).toISOString();
    this.lastTickAt = tickAt;
    this.lastHeartbeatAt = tickAt;

    this.logger.info("scheduler_tick", {
      scheduled: summary.scheduled,
      skipped: summary.skipped,
      reaped: reap.recovered,
      deadLettered: reap.deadLettered,
      mode: status.mode,
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        this.recordError(error);
      }
      await sleep(this.config.intervalMs, this.abortController.signal);
    }
  }

  private recordError(error: unknown): void {
    const classified = classifyError(error);
    this.lastErrorClass = classified.errorClass;
    this.logger.error("scheduler_error", {
      errorClass: classified.errorClass,
      errorCode: classified.errorCode,
    });
  }
}
