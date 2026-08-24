import { createHash } from "node:crypto";
import type { ActorSnapshot, DatabasePort, WriteCommand } from "@agent-voucher/shared-kernel";
import { newId, nowIso, requireRole } from "@agent-voucher/shared-kernel";
import type { ClaimedJob, JobLane } from "./job-runner.js";

export interface GraphPort {
  runSmoke(processId: string, revision: number, threadId: string): Promise<Record<string, unknown>>;
}

const MAX_JOB_JSON_BYTES = 16 * 1024;
const forbiddenJobKeys = new Set(["password", "secret", "appSecret", "accessToken", "tenantAccessToken", "authorization", "cookie"]);

function safeJobJson(value: unknown, label: string): string {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (forbiddenJobKeys.has(key)) throw new Error(`JOB_SENSITIVE_FIELD:${key}`);
      visit(child);
    }
  };
  visit(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_JOB_JSON_BYTES) throw new Error(`JOB_${label}_TOO_LARGE`);
  return json;
}

function jobRevision(job: Record<string, unknown> | ClaimedJob): number { return Number(job.revision); }
function jobId(job: Record<string, unknown> | ClaimedJob): string { return String(job.id); }

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
    return this.enqueueJob(actor, {
      type: "SYSTEM_HEALTH", lane: "MAINTENANCE", payload: {}, maxAttempts: 3,
      dedupeKey: `system-health:${newId()}`,
    });
  }

  async enqueueJob(actor: ActorSnapshot, input: {
    type: string;
    lane: JobLane;
    payload: unknown;
    maxAttempts?: number;
    dedupeKey?: string;
  }): Promise<string> {
    const id = newId(); const timestamp = nowIso();
    const payloadJson = safeJobJson(input.payload, "PAYLOAD");
    const requestedByJson = safeJobJson(actor, "ACTOR");
    await this.db.write(runtimeCommand(actor, "JOB_ENQUEUED", "job", id, [{
      sql: `INSERT INTO job_task(id, type, status, lane, requested_by_json, dedupe_key, payload_json, max_attempts, revision, created_at, updated_at)
            VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, 1, ?, ?)`,
      params: [id, input.type, input.lane, requestedByJson, input.dedupeKey ?? null, payloadJson, input.maxAttempts ?? 3, timestamp, timestamp],
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

  async claimNextJob(actor: ActorSnapshot, owner: string, lane: JobLane = "MAINTENANCE", leaseMs = 60_000): Promise<Record<string, unknown> | undefined> {
    const job = await this.db.read<Record<string, unknown> | undefined>({
      sql: "SELECT * FROM job_task WHERE status = 'PENDING' AND lane = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 1", params: [lane, nowIso()], mode: "get",
    });
    if (!job) return undefined;
    const revision = Number(job.revision);
    await this.db.write(runtimeCommand(actor, "JOB_CLAIMED", "job", String(job.id), [{
      sql: `UPDATE job_task SET status = 'RUNNING', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL,
            revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'PENDING'`,
      params: [owner, new Date(Date.now() + leaseMs).toISOString(), nowIso(), String(job.id), revision], expectChanges: 1,
    }], revision, revision + 1));
    return { ...job, status: "RUNNING", revision: revision + 1 };
  }

  async heartbeatJob(actor: ActorSnapshot, id: string, owner: string, leaseMs: number): Promise<void> {
    await this.db.write(runtimeCommand(actor, "JOB_HEARTBEAT", "job", id, [{
      sql: `UPDATE job_task SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
            WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?`,
      params: [new Date(Date.now() + leaseMs).toISOString(), nowIso(), nowIso(), id, owner], expectChanges: 1,
    }]));
  }

  async requestCancellation(actor: ActorSnapshot, id: string): Promise<void> {
    requireRole(actor, "ADMIN", "OPERATOR");
    await this.db.write(runtimeCommand(actor, "JOB_CANCELLATION_REQUESTED", "job", id, [{
      sql: `UPDATE job_task SET status = CASE WHEN status = 'PENDING' THEN 'CANCELLED' ELSE status END,
            cancel_requested_at = ?, revision = revision + CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END,
            updated_at = ? WHERE id = ? AND status IN ('PENDING','RUNNING')`,
      params: [nowIso(), nowIso(), id], expectChanges: 1,
    }]));
  }

  async cancelJobsByPayload(actor: ActorSnapshot, type: string, fieldName: string, fieldValue: string): Promise<number> {
    requireRole(actor, "ADMIN");
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(fieldName)) throw new Error("INVALID_JOB_PAYLOAD_FIELD");
    const count = await this.db.read<{ count: number }>({
      sql: `SELECT count(*) AS count FROM job_task WHERE type = ? AND status IN ('PENDING','RUNNING')
            AND json_extract(payload_json, ?) = ?`, params: [type, `$.${fieldName}`, fieldValue], mode: "get",
    });
    if (count.count === 0) return 0;
    await this.db.write(runtimeCommand(actor, "JOBS_CANCELLATION_REQUESTED", "job", `${type}:${fieldValue}`, [{
      sql: `UPDATE job_task SET status = CASE WHEN status = 'PENDING' THEN 'CANCELLED' ELSE status END,
            cancel_requested_at = ?, revision = revision + CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END, updated_at = ?
            WHERE type = ? AND status IN ('PENDING','RUNNING') AND json_extract(payload_json, ?) = ?`,
      params: [nowIso(), nowIso(), type, `$.${fieldName}`, fieldValue],
    }], undefined, undefined));
    return count.count;
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    const row = await this.db.read<{ cancel_requested_at: string | null } | undefined>({
      sql: "SELECT cancel_requested_at FROM job_task WHERE id = ?", params: [id], mode: "get",
    });
    return row?.cancel_requested_at !== null && row?.cancel_requested_at !== undefined;
  }

  async cancelClaimedJob(actor: ActorSnapshot, job: Record<string, unknown> | ClaimedJob, owner: string): Promise<void> {
    const revision = jobRevision(job); const id = jobId(job);
    await this.db.write(runtimeCommand(actor, "JOB_CANCELLED", "job", id, [{
      sql: `UPDATE job_task SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL,
            revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?`,
      params: [nowIso(), id, owner], expectChanges: 1,
    }], revision, revision + 1));
  }

  async completeJob(actor: ActorSnapshot, job: Record<string, unknown> | ClaimedJob, result: Record<string, unknown>, owner?: string): Promise<void> {
    const revision = jobRevision(job); const id = jobId(job); const resultJson = safeJobJson(result, "RESULT");
    await this.db.write(runtimeCommand(actor, "JOB_SUCCEEDED", "job", String(job.id), [{
      sql: `UPDATE job_task SET status = 'SUCCEEDED', result_json = ?, lease_owner = NULL, lease_expires_at = NULL,
            revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'RUNNING'
            AND cancel_requested_at IS NULL AND (? IS NULL OR lease_owner = ?)`,
      params: [resultJson, nowIso(), id, revision, owner ?? null, owner ?? null], expectChanges: 1,
    }], revision, revision + 1));
  }

  async failJob(actor: ActorSnapshot, job: Record<string, unknown> | ClaimedJob, code: string, retryable = true, retryAfterMs = 0, owner?: string): Promise<void> {
    const revision = jobRevision(job); const id = jobId(job);
    await this.db.write(runtimeCommand(actor, "JOB_FAILED", "job", String(job.id), [{
      sql: `UPDATE job_task SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'CANCELLED'
              WHEN ? = 1 AND attempts < max_attempts THEN 'PENDING' ELSE 'FAILED' END,
            next_attempt_at = CASE WHEN cancel_requested_at IS NULL AND ? = 1 AND attempts < max_attempts THEN ? ELSE NULL END,
            last_error_code = ?, lease_owner = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ? AND (? IS NULL OR lease_owner = ?)`,
      params: [retryable ? 1 : 0, retryable ? 1 : 0, new Date(Date.now() + Math.max(0, retryAfterMs)).toISOString(), code, nowIso(), id, revision, owner ?? null, owner ?? null], expectChanges: 1,
    }], revision, revision + 1));
  }

  async rejectJob(actor: ActorSnapshot, job: Record<string, unknown> | ClaimedJob, code: string): Promise<void> {
    const revision = jobRevision(job); const id = jobId(job);
    await this.db.write(runtimeCommand(actor, "JOB_REJECTED", "job", String(job.id), [{
      sql: `UPDATE job_task SET status = 'FAILED', last_error_code = ?, lease_owner = NULL, lease_expires_at = NULL,
            revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'RUNNING'`,
      params: [code, nowIso(), id, revision], expectChanges: 1,
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
