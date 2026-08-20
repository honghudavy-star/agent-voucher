import { createHash, randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { schemaSql, APP_SCHEMA_VERSION } from "./schema.js";
import type { DbWorkerRequest, DbWorkerResponse } from "./protocol.js";
import type { SqlStatement, WriteCommand } from "@agent-voucher/shared-kernel";

interface WorkerData {
  databasePath: string;
  readonly: boolean;
}

const data = workerData as WorkerData;
const db = new Database(data.databasePath, {
  readonly: data.readonly,
  fileMustExist: data.readonly,
  timeout: 5000,
});

if (!data.readonly) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("trusted_schema = OFF");
  db.exec(schemaSql);
  db.prepare("INSERT OR IGNORE INTO ops_schema_migration(version, applied_at) VALUES (?, ?)")
    .run(APP_SCHEMA_VERSION, new Date().toISOString());
} else {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("trusted_schema = OFF");
  db.pragma("query_only = ON");
}

function serializable(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  }
  return value;
}

function execute(statement: SqlStatement): unknown {
  const prepared = db.prepare(statement.sql);
  const params = statement.params ? [...statement.params] : [];
  if (statement.mode === "get") return serializable(prepared.get(...params));
  if (statement.mode === "all") return serializable(prepared.all(...params));
  const result = prepared.run(...params);
  if (statement.expectChanges !== undefined && result.changes !== statement.expectChanges) {
    const error = new Error("REVISION_CONFLICT");
    error.name = "ConflictError";
    throw error;
  }
  return { changes: result.changes, lastInsertRowid: serializable(result.lastInsertRowid) };
}

function commandHash(command: WriteCommand): string {
  if (command.requestHash) return command.requestHash;
  const canonical = JSON.stringify({
    commandType: command.commandType,
    commandVersion: command.commandVersion,
    expectedRevision: command.expectedRevision ?? null,
    statements: command.statements,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const applyWrite = db.transaction((command: WriteCommand) => {
  if (data.readonly) throw new Error("READ_ONLY_WORKER");
  const requestHash = commandHash(command);
  if (command.idempotencyKey) {
    const existing = db.prepare("SELECT request_hash, result_json FROM ops_idempotency WHERE key = ?")
      .get(command.idempotencyKey) as { request_hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error("IDEMPOTENCY_HASH_CONFLICT");
      const prior = JSON.parse(existing.result_json) as Record<string, unknown>;
      return { ...prior, replayed: true };
    }
  }

  const rows = command.statements.map(execute);
  const result = { commandId: command.commandId, replayed: false, rows };
  const audit = command.audit;
  db.prepare(`INSERT INTO aud_event(
    id, occurred_at, actor_id, actor_username, actor_roles_json, ip_address,
    action, object_type, object_id, before_revision, after_revision, result,
    correlation_id, metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(), new Date().toISOString(), command.actor.userId, command.actor.username,
      JSON.stringify(command.actor.roles), command.actor.ipAddress ?? null,
      audit.action, audit.objectType, audit.objectId,
      audit.beforeRevision ?? null, audit.afterRevision ?? null, audit.result,
      command.correlationId, JSON.stringify(audit.metadata ?? {}),
    );

  if (command.idempotencyKey) {
    db.prepare("INSERT INTO ops_idempotency(key, command_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(command.idempotencyKey, command.commandId, requestHash, JSON.stringify(result), new Date().toISOString());
  }
  return result;
});

async function handle(request: DbWorkerRequest): Promise<unknown> {
  switch (request.operation.kind) {
    case "query": return execute(request.operation.statement);
    case "write": return applyWrite(request.operation.command);
    case "health": {
      const quickCheck = db.pragma("quick_check", { simple: true });
      const foreignKeyIssues = db.pragma("foreign_key_check");
      return {
        quickCheck,
        foreignKeyIssues,
        journalMode: db.pragma("journal_mode", { simple: true }),
        synchronous: db.pragma("synchronous", { simple: true }),
        foreignKeys: db.pragma("foreign_keys", { simple: true }),
        trustedSchema: db.pragma("trusted_schema", { simple: true }),
        schemaVersion: APP_SCHEMA_VERSION,
      };
    }
    case "backup": {
      if (data.readonly) throw new Error("BACKUP_REQUIRES_WRITER");
      await db.backup(request.operation.destination);
      return { destination: request.operation.destination };
    }
    case "close": db.close(); return { closed: true };
  }
}

if (!parentPort) throw new Error("DB worker requires parentPort");
const port = parentPort;
port.on("message", (request: DbWorkerRequest) => {
  void handle(request).then(
    (value) => port.postMessage({ id: request.id, ok: true, value } satisfies DbWorkerResponse),
    (unknownError: unknown) => {
      const error = unknownError instanceof Error ? unknownError : new Error("Unknown database error");
      const code = "code" in error ? String(error.code) : undefined;
      port.postMessage({
        id: request.id,
        ok: false,
        error: { name: error.name, message: error.message, ...(code ? { code } : {}) },
      } satisfies DbWorkerResponse);
    },
  );
});
