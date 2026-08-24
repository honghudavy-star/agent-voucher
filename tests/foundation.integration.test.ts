import { appendFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessWorkspaceService, LegalEntityIdentitySchema, MasterDataSchema } from "@agent-voucher/access-workspace";
import { JobRunner, RuntimeAuditService } from "@agent-voucher/runtime-audit";
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
      workspaceName: "测试工作区", ledgerName: "测试总账",
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

  it("stores one legal identity with admin-only revision CAS and normalized aliases", async () => {
    expect(await access.getLegalIdentity()).toBeUndefined();
    expect(() => LegalEntityIdentitySchema.parse({
      legalName: "测试主体", taxpayerId: "invalid-id", aliases: [], revision: 0,
    })).toThrow();

    const operator: ActorSnapshot = { userId: "operator", username: "operator", roles: ["OPERATOR"] };
    await expect(access.updateLegalIdentity(operator, {
      legalName: "测试主体", taxpayerId: "91310000MA1K123456", aliases: [], revision: 0,
    })).rejects.toMatchObject({ name: "AuthorizationError" });

    await access.updateLegalIdentity(adminActor, {
      legalName: " 测试主体 ", taxpayerId: "91310000ma1k123456",
      aliases: ["旧名称", "旧名称", " 品牌名 "], revision: 0,
    });
    expect(await access.getLegalIdentity()).toEqual({
      legalName: "测试主体", taxpayerId: "91310000MA1K123456",
      aliases: ["旧名称", "品牌名"], revision: 1,
    });

    await access.updateLegalIdentity(adminActor, {
      legalName: "测试主体（新）", taxpayerId: "91310000MA1K123456", aliases: ["测试主体"], revision: 1,
    });
    await expect(access.updateLegalIdentity(adminActor, {
      legalName: "过期写入", taxpayerId: "91310000MA1K123456", aliases: [], revision: 1,
    })).rejects.toMatchObject({ name: "ConflictError", message: "LEGAL_IDENTITY_REVISION_CONFLICT" });
    expect(await access.getLegalIdentity()).toMatchObject({ legalName: "测试主体（新）", revision: 2 });

    const concurrent = await Promise.allSettled([
      access.updateLegalIdentity(adminActor, {
        legalName: "并发主体甲", taxpayerId: "91310000MA1K123456", aliases: [], revision: 2,
      }),
      access.updateLegalIdentity(adminActor, {
        legalName: "并发主体乙", taxpayerId: "91310000MA1K123456", aliases: [], revision: 2,
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await access.getLegalIdentity()).toMatchObject({ revision: 3 });

    expect((await runtime.listAudit(100)).some((event) =>
      event.action === "LEGAL_IDENTITY_UPDATED" && event.object_id === "default" && event.after_revision === 3)).toBe(true);
  });

  it("locks existing accounts after five failures, recovers after expiry, and invalidates revoked or expired sessions", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(access.authenticate({ username: "admin", password: "wrong-password" })).rejects.toThrow("用户名或密码错误");
    }
    await expect(access.authenticate({ username: "admin", password: "Foundation-Test-2026!" })).rejects.toThrow("用户名或密码错误");
    const locked = await db.read<{ id: string; locked_until: string } | undefined>({ sql: "SELECT id, locked_until FROM iam_user WHERE username = 'admin'", mode: "get" });
    expect(new Date(locked!.locked_until).getTime()).toBeGreaterThan(Date.now());
    await db.write({
      commandId: newId(), commandType: "TEST_ADVANCE_LOCK", commandVersion: 1, correlationId: newId(), actor: adminActor,
      statements: [{ sql: "UPDATE iam_user SET locked_until = ? WHERE id = ?", params: [new Date(Date.now() - 1000).toISOString(), locked!.id], expectChanges: 1 }],
      audit: { action: "TEST_ADVANCE_LOCK", objectType: "user", objectId: locked!.id, result: "SUCCESS" },
    });
    const session = await access.authenticate({ username: "admin", password: "Foundation-Test-2026!" });
    await access.revokeSession(session.actor, session.sessionId);
    expect(await access.getSession(session.token)).toBeUndefined();

    const expired = await access.authenticate({ username: "admin", password: "Foundation-Test-2026!" });
    await db.write({
      commandId: newId(), commandType: "TEST_EXPIRE_SESSION", commandVersion: 1, correlationId: newId(), actor: adminActor,
      statements: [{ sql: "UPDATE iam_session SET idle_expires_at = ? WHERE id = ?", params: [new Date(Date.now() - 1000).toISOString(), expired.sessionId], expectChanges: 1 }],
      audit: { action: "TEST_EXPIRE_SESSION", objectType: "session", objectId: expired.sessionId, result: "SUCCESS" },
    });
    expect(await access.getSession(expired.token)).toBeUndefined();
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

    await appendFile(join(backupDir, "app.snapshot.db"), "tamper");
    const rejectedRestoreDir = await mkdtemp(join(tmpdir(), "agent-voucher-tampered-"));
    await prepareDataDir(rejectedRestoreDir);
    await expect(restoreBackup(rejectedRestoreDir, backupDir)).rejects.toThrow("备份文件哈希校验失败");
    await rm(rejectedRestoreDir, { recursive: true, force: true });
  }, 20_000);

  it("rejects unknown job types instead of marking them successful", async () => {
    const id = newId(); const timestamp = new Date().toISOString();
    await db.write({
      commandId: newId(), commandType: "TEST_UNKNOWN_JOB", commandVersion: 1, correlationId: newId(), actor: adminActor,
      statements: [{ sql: `INSERT INTO job_task(id, type, status, payload_json, max_attempts, revision, created_at, updated_at)
        VALUES (?, 'UNKNOWN_TYPE', 'PENDING', '{}', 3, 1, ?, ?)`, params: [id, timestamp, timestamp] }],
      audit: { action: "TEST_UNKNOWN_JOB", objectType: "job", objectId: id, result: "SUCCESS" },
    });
    const runner = new JobRunner(runtime, () => Promise.resolve({ unexpected: true }));
    await runner.start();
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const job = await db.read<{ status: string; last_error_code: string | null } | undefined>({ sql: "SELECT status, last_error_code FROM job_task WHERE id = ?", params: [id], mode: "get" });
        if (job?.status === "FAILED") {
          expect(job.last_error_code).toBe("UNSUPPORTED_JOB_TYPE");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("unknown job was not rejected");
    } finally { await runner.stop(); }
  });

  it("recovers an expired claimed job and produces exactly one success", async () => {
    const id = await runtime.enqueueHealthCheck(adminActor);
    const claimed = await runtime.claimNextJob(adminActor, "crashed-worker");
    expect(claimed?.id).toBe(id);
    await db.write({
      commandId: newId(), commandType: "TEST_EXPIRE_LEASE", commandVersion: 1, correlationId: newId(), actor: adminActor,
      statements: [{ sql: "UPDATE job_task SET lease_expires_at = ? WHERE id = ?", params: [new Date(Date.now() - 1000).toISOString(), id], expectChanges: 1 }],
      audit: { action: "TEST_EXPIRE_LEASE", objectType: "job", objectId: id, result: "SUCCESS" },
    });
    await runtime.recoverExpiredJobs(adminActor);
    const runner = new JobRunner(runtime, () => Promise.resolve({ healthy: true }));
    await runner.start();
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const job = await db.read<{ status: string } | undefined>({ sql: "SELECT status FROM job_task WHERE id = ?", params: [id], mode: "get" });
        if (job?.status === "SUCCEEDED") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally { await runner.stop(); }
    const job = await db.read<{ status: string; attempts: number } | undefined>({ sql: "SELECT status, attempts FROM job_task WHERE id = ?", params: [id], mode: "get" });
    expect(job).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    const successes = (await runtime.listAudit(200)).filter((event) => event.action === "JOB_SUCCEEDED" && event.object_id === id);
    expect(successes).toHaveLength(1);
  });

  it("keeps plaintext credentials and tokens out of databases, backups, logs, and doctor output", async () => {
    const plaintextPassword = "Foundation-Test-2026!";
    const session = await access.authenticate({ username: "admin", password: plaintextPassword });
    const backupDir = join(dataDir, "privacy-backup");
    await createBackup(dataDir, db, graph, runtime, session.actor, backupDir);
    const sensitive = [plaintextPassword, session.token, session.csrfToken, "x".repeat(32)];
    const files: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name); const info = await stat(path);
        if (info.isDirectory()) await collect(path); else files.push(path);
      }
    };
    await collect(dataDir);
    for (const file of files) {
      const content = await readFile(file);
      for (const secret of sensitive) expect(content.includes(Buffer.from(secret))).toBe(false);
    }
    const doctor = JSON.stringify(await db.health());
    for (const secret of sensitive) expect(doctor).not.toContain(secret);
  });

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
