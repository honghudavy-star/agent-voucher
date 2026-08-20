import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "../../runtime/package-root.js";
import type { GraphOperation, GraphResponse } from "./protocol.js";

export class GraphClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly graphPath: string) {}

  async start(): Promise<void> {
    this.worker = new Worker(pathToFileURL(join(packageRoot, "dist", "graph-worker.js")), { workerData: { graphPath: this.graphPath } });
    this.worker.on("message", (response: GraphResponse) => {
      const pending = this.pending.get(response.id); if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error ?? "Graph worker failed"));
    });
    this.worker.on("error", (error: unknown) => this.rejectAll(error instanceof Error ? error : new Error("Graph worker失败")));
    this.worker.on("exit", (code) => { if (code !== 0) this.rejectAll(new Error(`Graph worker异常退出（${code}）`)); });
    try { await this.call({ kind: "health" }); }
    catch (error: unknown) {
      await this.worker.terminate(); this.worker = undefined;
      throw error;
    }
  }

  runSmoke(processId: string, revision: number, threadId: string): Promise<Record<string, unknown>> {
    return this.call({ kind: "smoke", processId, revision, threadId });
  }

  async backup(destination: string): Promise<void> { await this.call({ kind: "backup", destination }); }
  health(): Promise<Record<string, unknown>> { return this.call({ kind: "health" }); }

  async close(): Promise<void> {
    if (!this.worker) return;
    try { await this.call({ kind: "close" }); } catch { /* already closed */ }
    await this.worker.terminate(); this.worker = undefined;
  }

  private call<T>(operation: GraphOperation): Promise<T> {
    if (!this.worker) return Promise.reject(new Error("Graph worker未启动"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker?.postMessage({ id, operation });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
