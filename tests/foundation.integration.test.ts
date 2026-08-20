import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessWorkspaceService, MasterDataSchema } from "@agent-voucher/access-workspace";
import { RuntimeAuditService } from "@agent-voucher/runtime-audit";
import type { ActorSnapshot, WriteCommand } from "@agent-voucher/shared-kernel";
import { newId } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { GraphClient } from "../src/infrastructure/graph/client.js";
import { createBackup, restoreBackup } from "../src/runtime/backup.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

const adminActor: ActorSnapshot = { userId: "test-admin", username: "admin", roles: ["ADMIN"] };

describe("A01/A02 foundation", () => {
  let dataDir: string;
  let db: DbClient;
  let graph: GraphClient;
  let access: AccessWorkspaceService;
  let runtime: RuntimeAuditService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-voucher-test-"));
    const paths = await prepareDataDir(dataDir);
    db = new DbClient(paths.appDb); graph = new GraphClient(paths.graphDb);
    await db.start(); await graph.start();
    access = new AccessWorkspaceService(db); runtime = new RuntimeAuditService(db, graph);
    await access.bootstrap({
      token: "x".repeat(32), workspaceName: "测试工作区", ledgerName: "测试总账",
      username: "admin", displayName: "管理员", password: "Foundation-Test-2026!",
    });
  });

  afterEach(async () => {
    await graph.close(); await db.close(); await rm(dataDir, { recursive: true, force: true });
  });

  it("supports workspace revision CAS, role users and five concurrent sessions", async () => {
    const admin = await access.authenticate({ username: "admin", password: "Foundation-Test-2026!" });
    for (let index = 1; index <= 4; index += 1) {
      await access.createUser(admin.actor, {
        username: `user${index}`, displayName: `用户${index}`, password: `Foundation-User-${index}!`,
        roles: index === 4 ? ["REVIEWER"] : ["OPERATOR"],
      });
    }
    const sessions = await Promise.all([
      Promise.resolve(admin),
      ...[1, 2, 3, 4].map((index) => access.authenticate({ username: `user${index}`, password: `Foundation-User-${index}!` })),
    ]);
    const contexts = await Promise.all(sessions.map((session) => access.getSession(session.token)));
    expect(contexts.filter(Boolean)).toHaveLength(5);

    await access.updateWorkspace(admin.actor, { displayName: "新工作区", ledgerName: "新总账", revision: 1 });
    await expect(access.updateWorkspace(admin.actor, { displayName: "冲突", ledgerName: "冲突", revision: 1 }))
      .rejects.toMatchObject({ name: "ConflictError" });
    expect(await access.getWorkspace()).toMatchObject({ display_name: "新工作区", revision: 2 });
  }, 20_000);

  it("enforces idempotency hashes and immutable audit records", async () => {
    await access.createPeriod(adminActor, { period: "2026-08", status: "OPEN" });
    await access.createPeriod(adminActor, { period: "2026-08", status: "OPEN" });
    expect(await access.listPeriods()).toHaveLength(1);
    await expect(access.createPeriod(adminActor, { period: "2026-08", status: "CLOSED" }))
      .rejects.toMatchObject({ name: "ConflictError" });
    const period = (await access.listPeriods())[0]!;
    await access.updatePeriod(adminActor, String(period.id), { status: "CLOSED", revision: Number(period.revision) });
    expect((await access.listPeriods())[0]).toMatchObject({ status: "CLOSED", revision: 2 });

    expect(() => MasterDataSchema.parse({ type: "bank-account", name: "缺尾号账户" })).toThrow();
    await access.createMasterData(adminActor, { type: "supplier", code: "S-001", name: "测试供应商" });
    const supplier = (await access.listMasterData()).find((item) => item.type === "supplier")!;
    await access.disableMasterData(adminActor, "supplier", String(supplier.id), Number(supplier.revision));
    expect((await access.listMasterData()).find((item) => item.id === supplier.id)).toMatchObject({ status: "DISABLED", revision: 2 });

    const audit = await runtime.listAudit();
    const first = audit[0];
    expect(first).toBeDefined();
    const mutation: WriteCommand = {
      commandId: newId(), commandType: "AUDIT_TAMPER", commandVersion: 1, correlationId: newId(), actor: adminActor,
      statements: [{ sql: "UPDATE aud_event SET action = 'TAMPERED' WHERE id = ?", params: [String(first!.id)] }],
      audit: { action: "AUDIT_TAMPER", objectType: "audit", objectId: String(first!.id), result: "SUCCESS" },
    };
    await expect(db.write(mutation)).rejects.toThrow();
    const unchanged = await runtime.listAudit();
    expect(unchanged.find((item) => item.id === first!.id)?.action).not.toBe("TAMPERED");
  });

  it("persists a bounded LangGraph smoke flow and recovers a verified backup", async () => {
    const state = await runtime.runSmokeProcess(adminActor);
    expect(state).toMatchObject({ status: "SUCCEEDED", revision: 1 });
    const backupDir = join(dataDir, "external-backup");
    await createBackup(dataDir, db, graph, runtime, adminActor, backupDir);

    const restoredDir = await mkdtemp(join(tmpdir(), "agent-voucher-restored-"));
    await prepareDataDir(restoredDir);
    await restoreBackup(restoredDir, backupDir);
    const restoredPaths = await prepareDataDir(restoredDir);
    const restoredDb = new DbClient(restoredPaths.appDb); await restoredDb.start();
    try {
      const restored = new AccessWorkspaceService(restoredDb);
      expect(await restored.getWorkspace()).toMatchObject({ display_name: "测试工作区" });
      expect((await restoredDb.health()).quickCheck).toBe("ok");
    } finally {
      await restoredDb.close(); await rm(restoredDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps five-reader latency below the foundation threshold", async () => {
    const durations: number[] = [];
    await Promise.all(Array.from({ length: 5 }, async () => {
      for (let index = 0; index < 40; index += 1) {
        const start = performance.now(); await access.getWorkspace(); durations.push(performance.now() - start);
      }
    }));
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? Infinity;
    expect(p95).toBeLessThan(500);
  });
});
