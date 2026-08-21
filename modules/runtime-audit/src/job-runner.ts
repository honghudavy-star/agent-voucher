import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import type { RuntimeAuditService } from "./service.js";

const SYSTEM_ACTOR: ActorSnapshot = { userId: "SYSTEM", username: "runtime-worker", roles: ["ADMIN"] };

export const JobLanes = ["NETWORK", "PARSER", "MAINTENANCE"] as const;
export type JobLane = typeof JobLanes[number];

export interface ClaimedJob {
  readonly id: string;
  readonly type: string;
  readonly lane: JobLane;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly revision: number;
  readonly requestedBy: ActorSnapshot;
}

export interface JobContext {
  readonly jobId: string;
  readonly requestedBy: ActorSnapshot;
  readonly signal: AbortSignal;
  heartbeat(): Promise<void>;
}

export interface JobHandler<TPayload = unknown, TResult extends Record<string, unknown> = Record<string, unknown>> {
  readonly type: string;
  readonly lane: JobLane;
  readonly leaseMs: number;
  parsePayload(value: unknown): TPayload;
  handle(payload: TPayload, context: JobContext): Promise<TResult>;
  classifyError?(error: unknown): { code: string; retryable: boolean; retryAfterMs?: number };
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register<TPayload, TResult extends Record<string, unknown>>(handler: JobHandler<TPayload, TResult>): void {
    if (this.handlers.has(handler.type)) throw new Error(`JOB_HANDLER_DUPLICATE:${handler.type}`);
    this.handlers.set(handler.type, handler);
  }

  get(type: string): JobHandler | undefined { return this.handlers.get(type); }
}

function claimedJob(value: Record<string, unknown>): ClaimedJob {
  const lane = String(value.lane);
  if (!JobLanes.includes(lane as JobLane)) throw new Error(`INVALID_JOB_LANE:${lane}`);
  const payloadJson = typeof value.payload_json === "string" ? value.payload_json : "{}";
  const requestedByJson = typeof value.requested_by_json === "string" ? value.requested_by_json : "{}";
  return {
    id: String(value.id), type: String(value.type), lane: lane as JobLane,
    payload: JSON.parse(payloadJson) as unknown,
    attempts: Number(value.attempts), maxAttempts: Number(value.max_attempts), revision: Number(value.revision),
    requestedBy: JSON.parse(requestedByJson) as ActorSnapshot,
  };
}

export class JobRunner {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private readonly active = new Map<JobLane, Promise<void>>();
  private readonly abortControllers = new Map<JobLane, AbortController>();
  private readonly owner = `worker-${process.pid}`;
  readonly registry = new JobHandlerRegistry();

  constructor(private readonly service: RuntimeAuditService, health: () => Promise<Record<string, unknown>>) {
    this.registry.register({
      type: "SYSTEM_HEALTH", lane: "MAINTENANCE", leaseMs: 60_000,
      parsePayload: () => ({}), handle: health,
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.service.recoverExpiredJobs(SYSTEM_ACTOR);
    this.schedule(100);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const controller of this.abortControllers.values()) controller.abort(new Error("JOB_RUNNER_STOPPED"));
    await Promise.allSettled(this.active.values());
    await this.service.releaseLeases(SYSTEM_ACTOR, this.owner);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    try {
      for (const lane of JobLanes) {
        if (this.active.has(lane)) continue;
        const leaseMs = lane === "NETWORK" ? 300_000 : lane === "PARSER" ? 90_000 : 60_000;
        const raw = await this.service.claimNextJob(SYSTEM_ACTOR, this.owner, lane, leaseMs);
        if (!raw) continue;
        const job = claimedJob(raw);
        const promise = this.execute(job).finally(() => { this.active.delete(lane); this.abortControllers.delete(lane); });
        this.active.set(lane, promise);
      }
    } catch {
      // Claim conflicts and shutdown races fail closed; lease recovery retries them.
    }
    this.schedule(this.active.size === 0 ? 750 : 100);
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const handler = this.registry.get(job.type);
    if (!handler || handler.lane !== job.lane) {
      await this.service.rejectJob(SYSTEM_ACTOR, job, "UNSUPPORTED_JOB_TYPE");
      return;
    }
    const abort = new AbortController();
    this.abortControllers.set(job.lane, abort);
    if (await this.service.isCancellationRequested(job.id)) {
      await this.service.cancelClaimedJob(SYSTEM_ACTOR, job, this.owner); return;
    }
    const heartbeatMs = Math.max(5_000, Math.floor(handler.leaseMs / 3));
    const heartbeat = setInterval(() => {
      void this.service.heartbeatJob(SYSTEM_ACTOR, job.id, this.owner, handler.leaseMs).catch(() => undefined);
    }, heartbeatMs);
    const cancelPoll = setInterval(() => {
      void this.service.isCancellationRequested(job.id).then((requested) => {
        if (requested) abort.abort(new Error("JOB_CANCEL_REQUESTED"));
      }).catch(() => undefined);
    }, 1_000);
    try {
      const payload = handler.parsePayload(job.payload);
      const result = await handler.handle(payload, {
        jobId: job.id, requestedBy: job.requestedBy, signal: abort.signal,
        heartbeat: () => this.service.heartbeatJob(SYSTEM_ACTOR, job.id, this.owner, handler.leaseMs),
      });
      await this.service.completeJob(SYSTEM_ACTOR, job, result, this.owner);
    } catch (error: unknown) {
      if ((abort.signal.aborted && abort.signal.reason instanceof Error && abort.signal.reason.message === "JOB_CANCEL_REQUESTED")
        || await this.service.isCancellationRequested(job.id)) {
        await this.service.cancelClaimedJob(SYSTEM_ACTOR, job, this.owner); return;
      }
      const classified = handler.classifyError?.(error) ?? { code: "JOB_EXECUTION_FAILED", retryable: true };
      await this.service.failJob(SYSTEM_ACTOR, job, classified.code, classified.retryable, classified.retryAfterMs ?? 0, this.owner);
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelPoll);
      abort.abort();
    }
  }
}
