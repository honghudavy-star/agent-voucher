import { createHash } from "node:crypto";
import type { ActorSnapshot, DatabasePort, WriteCommand } from "@agent-voucher/shared-kernel";
import { newId, nowIso, requireRole } from "@agent-voucher/shared-kernel";

export interface GraphPort {
  runSmoke(processId: string, revision: number, threadId: string): Promise<Record<string, unknown>>;
}

function runtimeCommand(
  actor: ActorSnapshot,
  action: string,
  objectType: string,
  objectId: string,
  statements: WriteCommand["statements"],
  before?: number,
  after?: number,
  idempotencyKey?: string,
  result: "SUCCESS" | "REJECTED" | "FAILED" = "SUCCESS",
): WriteCommand {
  return {
    commandId: newId(), commandType: action, commandVersion: 1, correlationId: newId(), actor,
    ...(idempotencyKey ? { idempotencyKey } : {}), statements,
    audit: { action, objectType, objectId, beforeRevision: before ?? null, afterRevision: after ?? null, result },
  };
}

export class RuntimeAuditService {
  constructor(private readonly db: DatabasePort, private readonly graph: GraphPort) {}

  listJobs(limit = 50): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM job_task ORDER BY created_at DESC LIMIT ?", params: [limit], mode: "all" });
  }

  listAudit(limit = 100): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM aud_event ORDER BY occurred_at DESC LIMIT ?", params: [limit], mode: "all" });
  }

  listBackups(): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM ops_backup ORDER BY created_at DESC", mode: "all" });
  }

  async enqueueHealthCheck(actor: ActorSnapshot): Promise<string> {
    requireRole(actor, "ADMIN", "OPERATOR");
    const id = newId(); const timestamp = nowIso();
    await this.db.write(runtimeCommand(actor, "JOB_ENQUEUED", "job", id, [{
      sql: `INSERT INTO job_task(id, type, status, dedupe_key, payload_json, max_attempts, revision, created_at, updated_at)
            VALUES (?, 'SYSTEM_HEALTH', 'PENDING', ?, '{}', 3, 1, ?, ?)`,
      params: [id, `system-health:${id}`, timestamp, timestamp],
    }], undefined, 1));
    return id;
  }

  async recoverExpiredJobs(actor: ActorSnapshot): Promise<void> {
    await this.db.write(runtimeCommand(actor, "JOB_LEASES_RECOVERED", "job", "expired", [{
      sql: `UPDATE job_task SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
            revision = revision + 1, updated_at = ?
            WHERE status = 'RUNNING' AND lease_expires_at < ?`, params: [nowIso(), nowIso()],
    }]));
  }

  async releaseLeases(actor: ActorSnapshot, owner: string): Promise<void> {
    await this.db.write(runtimeCommand(actor, "JOB_LEASES_RELEASED", "job", owner, [{
      sql: `UPDATE job_task SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
            revision = revision + 1, updated_at = ? WHERE status = 'RUNNING' AND lease_owner = ?`,
      params: [nowIso(), owner],
    }]));
  }

  async recordRejected(actor: ActorSnapshot, action: string, objectType: string, objectId: string): Promise<void> {
    await this.db.write(runtimeCommand(actor, action, objectType, objectId, [], undefined, undefined, undefined, "REJECTED"));
  }

  async claimNextJob(actor: ActorSnapshot, owner: string): Promise<Record<string, unknown> | undefined> {
    const job = await this.db.read<Record<string, unknown> | undefined>({
      sql: "SELECT * FROM job_task WHERE status = 'PENDING' ORDER BY created_at LIMIT 1", mode: "get",
    });
    if (!job) return undefined;
    const revision = Number(job.revision);
    await this.db.write(runtimeCommand(actor, "JOB_CLAIMED", "job", String(job.id), [{
      sql: `UPDATE job_task SET status = 'RUNNING', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
            revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'PENDING'`,
      params: [owner, new Date(Date.now() + 60_000).toISOString(), nowIso(), String(job.id), revision], expectChanges: 1,
    }], revision, revision + 1));
    return { ...job, status: "RUNNING", revision: revision + 1 };
  }

  async completeJob(actor: ActorSnapshot, job: Record<string, unknown>, result: Record<string, unknown>): Promise<void> {
    const revision = Number(job.revision);
    await this.db.write(runtimeCommand(actor, "JOB_SUCCEEDED", "job", String(job.id), [{
      sql: `UPDATE job_task SET status = 'SUCCEEDED', result_json = ?, lease_owner = NULL, lease_expires_at = NULL,
            revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'RUNNING'`,
      params: [JSON.stringify(result), nowIso(), String(job.id), revision], expectChanges: 1,
    }], revision, revision + 1));
  }

  async failJob(actor: ActorSnapshot, job: Record<string, unknown>, code: string): Promise<void> {
    const revision = Number(job.revision);
    await this.db.write(runtimeCommand(actor, "JOB_FAILED", "job", String(job.id), [{
      sql: `UPDATE job_task SET status = CASE WHEN attempts < max_attempts THEN 'PENDING' ELSE 'FAILED' END,
            last_error_code = ?, lease_owner = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?`, params: [code, nowIso(), String(job.id), revision], expectChanges: 1,
    }], revision, revision + 1));
  }

  async runSmokeProcess(actor: ActorSnapshot): Promise<Record<string, unknown>> {
    requireRole(actor, "ADMIN");
    const processId = newId(); const threadId = newId(); const timestamp = nowIso();
    await this.db.write(runtimeCommand(actor, "PROCESS_STARTED", "process", processId, [{
      sql: `INSERT INTO prc_process_instance(id, definition, definition_version, thread_id, status, state_hash, revision, created_at, updated_at)
            VALUES (?, 'runtime-smoke', 1, ?, 'RUNNING', ?, 1, ?, ?)`,
      params: [processId, threadId, createHash("sha256").update("RUNNING").digest("hex"), timestamp, timestamp],
    }], undefined, 1));
    const state = await this.graph.runSmoke(processId, 1, threadId);
    const stateHash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    await this.db.write(runtimeCommand(actor, "PROCESS_SUCCEEDED", "process", processId, [{
      sql: "UPDATE prc_process_instance SET status = 'SUCCEEDED', state_hash = ?, revision = 2, updated_at = ? WHERE id = ? AND revision = 1",
      params: [stateHash, nowIso(), processId], expectChanges: 1,
    }], 1, 2));
    return state;
  }

  async recordBackup(actor: ActorSnapshot, id: string, path: string, manifestHash: string): Promise<void> {
    requireRole(actor, "ADMIN"); const timestamp = nowIso();
    await this.db.write(runtimeCommand(actor, "BACKUP_VERIFIED", "backup", id, [{
      sql: "INSERT INTO ops_backup(id, path, manifest_hash, status, created_at, verified_at) VALUES (?, ?, ?, 'VERIFIED', ?, ?)",
      params: [id, path, manifestHash, timestamp, timestamp],
    }], undefined, 1));
  }
}
