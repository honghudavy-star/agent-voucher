import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { accessWorkspaceMigrations } from "@agent-voucher/access-workspace";
import { EvidenceVaultService } from "@agent-voucher/evidence-vault";
import { runtimeAuditMigrations } from "@agent-voucher/runtime-audit";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { GraphClient } from "../src/infrastructure/graph/client.js";
import { createBackup, restoreBackup } from "../src/runtime/backup.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

const actor: ActorSnapshot = { userId: "admin", username: "admin", roles: ["ADMIN"] };
function chunks(value: string): AsyncIterable<Uint8Array> { return Readable.from([Buffer.from(value)]); }

describe("A04 evidence vault", () => {
  let dataDir: string; let db: DbClient; let graph: GraphClient; let vault: EvidenceVaultService;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-voucher-evidence-")); const paths = await prepareDataDir(dataDir);
    db = new DbClient(paths.appDb); graph = new GraphClient(paths.graphDb); await db.start(); await graph.start();
    vault = new EvidenceVaultService(db, dataDir); await vault.start();
  });
  afterEach(async () => { await graph.close(); await db.close(); await rm(dataDir, { recursive: true, force: true }); });

  it("streams immutable content, reuses physical bytes and preserves every import occurrence", async () => {
    const first = await vault.ingest({
      kind: "BANK_STATEMENT", sourceKind: "LOCAL_UPLOAD", originalName: "流水.csv", idempotencyKey: "upload-1", actor,
      chunks: chunks("日期,金额,余额\n2026-08-01,1.00,1.00\n"),
    });
    const second = await vault.ingest({
      kind: "BANK_STATEMENT", sourceKind: "LOCAL_UPLOAD", originalName: "再次上传.csv", idempotencyKey: "upload-2", actor,
      chunks: chunks("日期,金额,余额\n2026-08-01,1.00,1.00\n"),
    });
    expect(first.status).toBe("STORED"); expect(second.status).toBe("PHYSICAL_DUPLICATE");
    if (first.status === "QUARANTINED" || second.status === "QUARANTINED") throw new Error("unexpected quarantine");
    expect(second.contentHash).toBe(first.contentHash); expect(second.evidenceId).not.toBe(first.evidenceId);
    expect(await readFile(vault.objectPath((await vault.objectReference(first.evidenceId))!.relativePath), "utf8")).toContain("2026-08-01");
    expect(await vault.list()).toHaveLength(2);
    await expect(db.write({
      commandId: "tamper-revision", commandType: "TEST_TAMPER", commandVersion: 1, correlationId: "tamper", actor,
      statements: [{ sql: "UPDATE evd_revision SET original_name = 'changed.csv' WHERE id = ?", params: [first.revisionId] }],
      audit: { action: "TEST_TAMPER", objectType: "evidence", objectId: first.evidenceId, result: "SUCCESS" },
    })).rejects.toThrow(/EVIDENCE_REVISION_IMMUTABLE/);
    const replay = await vault.ingest({
      kind: "BANK_STATEMENT", sourceKind: "LOCAL_UPLOAD", originalName: "ignored.csv", idempotencyKey: "upload-1", actor,
      chunks: chunks("different"),
    });
    expect(replay).toMatchObject({ evidenceId: first.evidenceId, revisionId: first.revisionId });
    const objectPath = vault.objectPath((await vault.objectReference(first.evidenceId))!.relativePath);
    await chmod(objectPath, 0o600); await writeFile(objectPath, "mutated-after-ingest");
    await expect(vault.verifiedObjectPath(first.evidenceId)).rejects.toThrow(/HASH_MISMATCH/);
  });

  it("quarantines spoofed files, purges them and records Feishu tombstones", async () => {
    const quarantined = await vault.ingest({ kind: "INVOICE", sourceKind: "LOCAL_UPLOAD", originalName: "fake.pdf", idempotencyKey: "bad", actor, chunks: chunks("not a pdf") });
    expect(quarantined.status).toBe("QUARANTINED"); expect(await vault.listQuarantine()).toHaveLength(1);
    const declaredMismatch = await vault.ingest({
      kind: "CONTRACT_FILE", sourceKind: "LOCAL_UPLOAD", originalName: "contract.pdf", declaredMediaType: "image/png",
      idempotencyKey: "declared-mismatch", actor, chunks: chunks("%PDF-1.4\n%%EOF\n"),
    });
    expect(declaredMismatch).toMatchObject({ status: "QUARANTINED", reason: "DECLARED_MEDIA_TYPE_MISMATCH" });
    expect(await vault.purgeExpired(actor, new Date(Date.now() + 8 * 24 * 60 * 60_000))).toBe(2);
    const remote = await vault.ingest({
      kind: "APPROVAL", sourceKind: "FEISHU", originalName: "approval.json", sourceRef: "instance-1", sourceRevision: "r1",
      idempotencyKey: "feishu-r1", actor, chunks: chunks('{"status":"APPROVED"}'),
    });
    if (remote.status === "QUARANTINED") throw new Error("unexpected quarantine");
    const attachment = await vault.ingest({
      kind: "CONTRACT_FILE", sourceKind: "FEISHU", originalName: "contract.pdf", declaredMediaType: "application/pdf",
      sourceRef: "instance-1:contract:0", sourceRevision: "r1", idempotencyKey: "feishu-attachment-r1", actor,
      chunks: chunks("%PDF-1.4\n%%EOF\n"),
    });
    if (attachment.status === "QUARANTINED") throw new Error("unexpected quarantine");
    expect(await vault.tombstoneSourceTree(actor, "instance-1", "CANCELED:r2")).toBe(2);
    expect(await vault.get(remote.evidenceId)).toMatchObject({ status: "TOMBSTONED" });
    expect(await vault.get(attachment.evidenceId)).toMatchObject({ status: "TOMBSTONED" });
  });

  it("publishes backup v2 only after copying every referenced evidence object and restores it", async () => {
    const item = await vault.ingest({
      kind: "BANK_STATEMENT", sourceKind: "LOCAL_UPLOAD", originalName: "backup.csv", idempotencyKey: "backup-item", actor,
      chunks: chunks("日期,金额,余额\n2026-08-01,1.00,1.00\n"),
    });
    if (item.status === "QUARANTINED") throw new Error("unexpected quarantine");
    const backup = await createBackup(dataDir, db, graph); const manifest = JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8")) as { formatVersion: number; evidence: unknown[] };
    expect(manifest.formatVersion).toBe(2); expect(manifest.evidence).toHaveLength(1);
    const restored = await mkdtemp(join(tmpdir(), "agent-voucher-restore-v2-")); await prepareDataDir(restored);
    try {
      expect(await restoreBackup(restored, backup)).toBeTruthy();
      const restoredDb = new DbClient(join(restored, "db", "app.db")); await restoredDb.start();
      const restoredVault = new EvidenceVaultService(restoredDb, restored); await restoredVault.start();
      expect(await restoredVault.get(item.evidenceId)).toMatchObject({ content_hash: item.contentHash });
      await restoredDb.close();
      const graphSnapshot = join(backup, "graph.snapshot.db"); const graphBytes = await readFile(graphSnapshot);
      await writeFile(graphSnapshot, "not-a-sqlite-database");
      const graphManifest = JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8")) as { graphDb: { sha256: string } };
      graphManifest.graphDb.sha256 = createHash("sha256").update(await readFile(graphSnapshot)).digest("hex");
      await writeFile(join(backup, "backup-manifest.json"), `${JSON.stringify(graphManifest)}\n`);
      const graphRejected = await mkdtemp(join(tmpdir(), "agent-voucher-graph-reject-")); await prepareDataDir(graphRejected);
      try { await expect(restoreBackup(graphRejected, backup)).rejects.toThrow(); }
      finally { await rm(graphRejected, { recursive: true, force: true }); }
      await writeFile(graphSnapshot, graphBytes); graphManifest.graphDb.sha256 = createHash("sha256").update(graphBytes).digest("hex");
      await writeFile(join(backup, "backup-manifest.json"), `${JSON.stringify(graphManifest)}\n`);
      const snapshot = join(backup, "app.snapshot.db"); const corrupt = new Database(snapshot);
      const migrationRow = corrupt.prepare("SELECT checksum FROM ops_module_migration WHERE id = 'a04-evidence-v1'").get() as { checksum: string };
      corrupt.prepare("UPDATE ops_module_migration SET checksum = ? WHERE id = 'a04-evidence-v1'").run("0".repeat(64)); corrupt.close();
      const driftManifest = JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8")) as { appDb: { sha256: string } };
      driftManifest.appDb.sha256 = createHash("sha256").update(await readFile(snapshot)).digest("hex");
      await writeFile(join(backup, "backup-manifest.json"), `${JSON.stringify(driftManifest)}\n`);
      const driftRejected = await mkdtemp(join(tmpdir(), "agent-voucher-drift-reject-")); await prepareDataDir(driftRejected);
      try { await expect(restoreBackup(driftRejected, backup)).rejects.toThrow(/MIGRATION_CHECKSUM_DRIFT/); }
      finally { await rm(driftRejected, { recursive: true, force: true }); }
      const repair = new Database(snapshot); repair.prepare("UPDATE ops_module_migration SET checksum = ? WHERE id = 'a04-evidence-v1'").run(migrationRow.checksum);
      repair.prepare("INSERT INTO ops_schema_migration(version, applied_at) VALUES (999, ?)").run(new Date().toISOString()); repair.close();
      const newerManifest = JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8")) as { appDb: { sha256: string } };
      newerManifest.appDb.sha256 = createHash("sha256").update(await readFile(snapshot)).digest("hex");
      await writeFile(join(backup, "backup-manifest.json"), `${JSON.stringify(newerManifest)}\n`);
      const newerRejected = await mkdtemp(join(tmpdir(), "agent-voucher-newer-reject-")); await prepareDataDir(newerRejected);
      try { await expect(restoreBackup(newerRejected, backup)).rejects.toThrow(/Schema版本/); }
      finally { await rm(newerRejected, { recursive: true, force: true }); }
      const corruptForeignKey = new Database(snapshot); corruptForeignKey.prepare("DELETE FROM ops_schema_migration WHERE version = 999").run();
      corruptForeignKey.pragma("foreign_keys = OFF"); corruptForeignKey.prepare("INSERT INTO iam_user_role(user_id, role) VALUES ('missing-user', 'ADMIN')").run(); corruptForeignKey.close();
      const updated = JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8")) as { appDb: { sha256: string } };
      updated.appDb.sha256 = createHash("sha256").update(await readFile(snapshot)).digest("hex");
      await writeFile(join(backup, "backup-manifest.json"), `${JSON.stringify(updated)}\n`);
      const rejected = await mkdtemp(join(tmpdir(), "agent-voucher-restore-reject-")); await prepareDataDir(rejected);
      try { await expect(restoreBackup(rejected, backup)).rejects.toThrow(/完整性检查失败/); }
      finally { await rm(rejected, { recursive: true, force: true }); }
    } finally { await rm(restored, { recursive: true, force: true }); }
  });

  it("restores a genuine Phase 1 format-v1 backup before applying module migrations", async () => {
    const legacyBackup = await mkdtemp(join(tmpdir(), "agent-voucher-v1-backup-"));
    const legacyRestore = await mkdtemp(join(tmpdir(), "agent-voucher-v1-restore-")); await prepareDataDir(legacyRestore);
    try {
      const appPath = join(legacyBackup, "app.snapshot.db"); const legacy = new Database(appPath);
      legacy.exec(`CREATE TABLE ops_schema_migration(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
        INSERT INTO ops_schema_migration(version, applied_at) VALUES (1, '2026-08-20T00:00:00.000Z');
        ${accessWorkspaceMigrations[0].upSql}
        ${runtimeAuditMigrations[0].upSql}`); legacy.close();
      const graphPath = join(legacyBackup, "graph.snapshot.db"); await graph.backup(graphPath);
      const manifest = {
        formatVersion: 1, backupId: "legacy-v1", createdAt: new Date().toISOString(),
        appDb: { file: "app.snapshot.db", sha256: createHash("sha256").update(await readFile(appPath)).digest("hex") },
        graphDb: { file: "graph.snapshot.db", sha256: createHash("sha256").update(await readFile(graphPath)).digest("hex") },
      };
      await writeFile(join(legacyBackup, "backup-manifest.json"), `${JSON.stringify(manifest)}\n`);
      await expect(restoreBackup(legacyRestore, legacyBackup)).resolves.toBe("legacy-v1");
      const migrated = new DbClient(join(legacyRestore, "db", "app.db")); await migrated.start();
      expect((await migrated.health()).schemaVersion).toBe(2); await migrated.close();
    } finally { await rm(legacyBackup, { recursive: true, force: true }); await rm(legacyRestore, { recursive: true, force: true }); }
  });
});
