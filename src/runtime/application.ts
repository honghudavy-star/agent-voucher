import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { AccessWorkspaceService } from "@agent-voucher/access-workspace";
import { JobRunner, RuntimeAuditService } from "@agent-voucher/runtime-audit";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import open from "open";
import { DbClient } from "../infrastructure/db/client.js";
import { GraphClient } from "../infrastructure/graph/client.js";
import { createServer } from "../web/server.js";
import type { FastifyInstance } from "fastify";
import { prepareDataDir } from "./data-dir.js";
import { acquireInstanceLock, type InstanceLock } from "./instance-lock.js";

const SYSTEM_ACTOR: ActorSnapshot = { userId: "SYSTEM", username: "runtime-worker", roles: ["ADMIN"] };

export interface StartOptions {
  dataDir: string;
  port: number;
  lanMode: boolean;
  noOpen: boolean;
}

export class ApplicationRuntime {
  private db?: DbClient;
  private graph?: GraphClient;
  private server?: FastifyInstance;
  private runner?: JobRunner;
  private lock?: InstanceLock;
  private stopped = false;

  async start(options: StartOptions): Promise<{ url: string; setupUrl?: string }> {
    this.stopped = false;
    const paths = await prepareDataDir(options.dataDir);
    this.lock = await acquireInstanceLock(paths.lockFile);
    try {
      this.db = new DbClient(paths.appDb); await this.db.start();
      this.graph = new GraphClient(paths.graphDb); await this.graph.start();
      const access = new AccessWorkspaceService(this.db);
      const runtime = new RuntimeAuditService(this.db, this.graph);
      const setupToken = randomBytes(32).toString("base64url");
      const setupHash = createHash("sha256").update(setupToken).digest();
      const setupExpires = Date.now() + 15 * 60_000;
      let setupConsumed = false;
      const setupTokenValid = (candidate: string): boolean => {
        if (setupConsumed || Date.now() > setupExpires) return false;
        const candidateHash = createHash("sha256").update(candidate).digest();
        const valid = candidateHash.length === setupHash.length && candidateHash.equals(setupHash);
        if (valid) setupConsumed = true;
        return valid;
      };
      this.runner = new JobRunner(runtime, async () => {
        const [database, graph] = await Promise.all([this.db!.health(), this.graph!.health()]);
        const process = await runtime.runSmokeProcess(SYSTEM_ACTOR);
        return { database, graph, process };
      });
      await this.runner.start();
      const host = options.lanMode ? "0.0.0.0" : "127.0.0.1";
      this.server = await createServer({
        host, port: options.port, lanMode: options.lanMode, dataDir: options.dataDir,
        setupTokenValid, access, runtime, db: this.db, graph: this.graph,
      });
      const url = `http://127.0.0.1:${options.port}`;
      const setupUrl = await access.isSetup() ? undefined : `${url}/setup#token=${setupToken}`;
      if (!options.noOpen) void open(setupUrl ?? url).catch(() => undefined);
      return { url, ...(setupUrl ? { setupUrl } : {}) };
    } catch (error: unknown) {
      await this.shutdown();
      throw error;
    }
  }

  lanUrls(port: number): string[] {
    const urls: string[] = [];
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal && (entry.address.startsWith("10.") || entry.address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address))) {
          urls.push(`http://${entry.address}:${port}`);
        }
      }
    }
    return urls;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return; this.stopped = true;
    await this.runner?.stop().catch(() => undefined);
    await this.server?.close().catch(() => undefined);
    await this.graph?.close().catch(() => undefined);
    await this.db?.close().catch(() => undefined);
    await this.lock?.release().catch(() => undefined);
  }
}
