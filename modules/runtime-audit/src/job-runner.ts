import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import type { RuntimeAuditService } from "./service.js";

const SYSTEM_ACTOR: ActorSnapshot = { userId: "SYSTEM", username: "runtime-worker", roles: ["ADMIN"] };

export class JobRunner {
  private timer?: NodeJS.Timeout;
  private currentTick: Promise<void> | undefined;
  private stopped = true;
  private readonly owner = `worker-${process.pid}`;

  constructor(private readonly service: RuntimeAuditService, private readonly health: () => Promise<Record<string, unknown>>) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.service.recoverExpiredJobs(SYSTEM_ACTOR);
    this.schedule(100);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.currentTick;
    await this.service.releaseLeases(SYSTEM_ACTOR, this.owner);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.currentTick = this.tick().finally(() => { this.currentTick = undefined; });
    }, delay);
  }

  private async tick(): Promise<void> {
    try {
      const job = await this.service.claimNextJob(SYSTEM_ACTOR, this.owner);
      if (!job) return this.schedule(750);
      try {
        const result = String(job.type) === "SYSTEM_HEALTH" ? await this.health() : { skipped: true };
        await this.service.completeJob(SYSTEM_ACTOR, job, result);
      } catch {
        await this.service.failJob(SYSTEM_ACTOR, job, "JOB_EXECUTION_FAILED");
      }
    } catch {
      // A concurrent claim or shutdown is expected to fail closed.
    }
    this.schedule(100);
  }
}
