import { Worker } from "node:worker_threads";
import type { CommandResult, SqlStatement, WriteCommand } from "@agent-voucher/shared-kernel";
import { ConflictError, QueueFullError } from "@agent-voucher/shared-kernel";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "../../runtime/package-root.js";
import type { DbWorkerOperation, DbWorkerResponse } from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class RpcWorker {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private active = true;

  constructor(private readonly worker: Worker) {
    worker.on("message", (response: DbWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else {
        const message = response.error?.message ?? "数据库Worker失败";
        const error = message === "REVISION_CONFLICT"
          ? new ConflictError()
          : message === "IDEMPOTENCY_HASH_CONFLICT"
            ? new ConflictError("相同幂等键对应了不同请求，已拒绝执行")
            : message.includes("AUDIT_IMMUTABLE")
              ? new Error("AUDIT_IMMUTABLE")
            : response.error?.code?.startsWith("SQLITE_CONSTRAINT")
              ? new ConflictError("记录已存在或不满足数据约束")
              : new Error(message);
        pending.reject(error);
      }
    });
    worker.on("error", (error: unknown) => { this.active = false; this.rejectAll(error instanceof Error ? error : new Error("数据库Worker失败")); });
    worker.on("exit", (code) => {
      this.active = false;
      if (code !== 0) this.rejectAll(new Error(`数据库Worker异常退出（${code}）`));
    });
  }

  get pendingCount(): number { return this.pending.size; }

  call<T>(operation: DbWorkerOperation): Promise<T> {
    if (!this.active) return Promise.reject(new Error("数据库Worker不可用"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, operation });
    });
  }

  async terminate(): Promise<void> {
    if (this.active) try { await this.call({ kind: "close" }); } catch { /* worker may already be gone */ }
    await this.worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function verifyDatabaseSnapshot(databasePath: string): Promise<Record<string, unknown>> {
  const worker = new RpcWorker(new Worker(pathToFileURL(join(packageRoot, "dist", "db-worker.js")), {
    workerData: { databasePath, readonly: true },
  }));
  try {
    return await worker.call({ kind: "health" });
  } finally {
    await worker.terminate();
  }
}

export class DbClient {
  private writer: RpcWorker | undefined;
  private readers: RpcWorker[] = [];
  private readerIndex = 0;
  readonly maxWriteQueue = 100;

  constructor(private readonly databasePath: string) {}

  async start(): Promise<void> {
    const workerUrl = pathToFileURL(join(packageRoot, "dist", "db-worker.js"));
    try {
      this.writer = new RpcWorker(new Worker(workerUrl, { workerData: { databasePath: this.databasePath, readonly: false } }));
      await this.writer.call({ kind: "health" });
      this.readers = [0, 1].map(() => new RpcWorker(new Worker(workerUrl, {
        workerData: { databasePath: this.databasePath, readonly: true },
      })));
      await Promise.all(this.readers.map((reader) => reader.call({ kind: "health" })));
    } catch (error: unknown) {
      await this.close();
      throw error;
    }
  }

  async read<T>(statement: SqlStatement): Promise<T> {
    const reader = this.readers[this.readerIndex++ % this.readers.length];
    if (!reader) throw new Error("数据库未启动");
    return reader.call<T>({ kind: "query", statement });
  }

  async write(command: WriteCommand): Promise<CommandResult> {
    if (!this.writer) throw new Error("数据库未启动");
    if (this.writer.pendingCount >= this.maxWriteQueue) throw new QueueFullError();
    return this.writer.call<CommandResult>({ kind: "write", command });
  }

  async health(): Promise<Record<string, unknown>> {
    if (!this.writer) throw new Error("数据库未启动");
    return this.writer.call({ kind: "health" });
  }

  async backup(destination: string): Promise<void> {
    if (!this.writer) throw new Error("数据库未启动");
    await this.writer.call({ kind: "backup", destination });
  }

  async close(): Promise<void> {
    await Promise.all([...this.readers, ...(this.writer ? [this.writer] : [])].map((worker) => worker.terminate()));
    this.readers = [];
    this.writer = undefined;
  }
}
