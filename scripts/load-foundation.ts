import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessWorkspaceService } from "@agent-voucher/access-workspace";
import { JobRunner, RuntimeAuditService } from "@agent-voucher/runtime-audit";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { GraphClient } from "../src/infrastructure/graph/client.js";
import { createBackup } from "../src/runtime/backup.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

const durationMs = Number(process.env.AGENT_VOUCHER_LOAD_MS ?? 30 * 60_000);
if (!Number.isFinite(durationMs) || durationMs < 1000) throw new Error("AGENT_VOUCHER_LOAD_MS必须至少为1000");

const dataDir = await mkdtemp(join(tmpdir(), "agent-voucher-load-"));
const paths = await prepareDataDir(dataDir);
const db = new DbClient(paths.appDb); const graph = new GraphClient(paths.graphDb);
await db.start(); await graph.start();
const access = new AccessWorkspaceService(db); const runtime = new RuntimeAuditService(db, graph);
const systemActor: ActorSnapshot = { userId: "SYSTEM", username: "load-runner", roles: ["ADMIN"] };
const runner = new JobRunner(runtime, async () => ({ database: await db.health(), graph: await graph.health() }));

const reads: number[] = []; const writes: number[] = []; const errors: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const measure = async <T>(bucket: number[], action: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  try { return await action(); } finally { bucket.push(performance.now() - started); }
};

try {
  await access.bootstrap({ token: "x".repeat(32), workspaceName: "负载测试", ledgerName: "负载总账", username: "admin", displayName: "管理员", password: "Foundation-Test-2026!" });
  const admin = await access.authenticate({ username: "admin", password: "Foundation-Test-2026!" });
  for (let index = 1; index <= 4; index += 1) {
    await access.createUser(admin.actor, {
      username: `load${index}`, displayName: `负载用户${index}`, password: `Foundation-Load-${index}!`,
      roles: index === 4 ? ["REVIEWER"] : ["OPERATOR"],
    });
  }
  const sessions = await Promise.all([
    Promise.resolve(admin),
    ...[1, 2, 3, 4].map((index) => access.authenticate({ username: `load${index}`, password: `Foundation-Load-${index}!` })),
  ]);
  await runner.start();
  const deadline = Date.now() + durationMs;
  let writeIndex = 0;
  await Promise.all(sessions.map(async (session, sessionIndex) => {
    while (Date.now() < deadline) {
      try {
        await measure(reads, async () => {
          await Promise.all([access.getSession(session.token), access.getWorkspace(), sessionIndex === 4 ? runtime.listAudit(20) : runtime.listJobs(20)]);
        });
        if (sessionIndex === 0 && writeIndex % 8 === 0) {
          const current = writeIndex++;
          await measure(writes, () => access.createMasterData(session.actor, {
            type: "supplier", code: `LOAD-${current.toString().padStart(6, "0")}`, name: `负载供应商${current}`,
          }));
          await measure(writes, () => runtime.enqueueHealthCheck(session.actor));
        } else if (sessionIndex === 0) writeIndex += 1;
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : "unknown load error");
      }
      await sleep(100);
    }
  }));
  await createBackup(dataDir, db, graph, runtime, admin.actor, join(dataDir, "load-backup"));
  await runner.stop();
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor(values.length * p)] ?? Infinity;
  const report = {
    durationMs, sessions: sessions.length, reads: reads.length, writes: writes.length,
    readP95Ms: percentile(reads, 0.95), writeP95Ms: percentile(writes, 0.95),
    errors: errors.length, database: await db.health(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.sessions !== 5 || report.readP95Ms >= 500 || report.writeP95Ms >= 1000 || report.errors > 0) process.exitCode = 1;
} finally {
  await runner.stop().catch(() => undefined);
  await graph.close(); await db.close(); await rm(dataDir, { recursive: true, force: true });
}
