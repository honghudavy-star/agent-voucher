import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import type { RuntimeAuditService } from "@agent-voucher/runtime-audit";
import { verifyDatabaseSnapshot, type DbClient } from "../infrastructure/db/client.js";
import { APP_SCHEMA_VERSION, validateMigrationLedger } from "../infrastructure/db/migrations.js";
import { GraphClient } from "../infrastructure/graph/client.js";
import { dataPaths } from "./paths.js";

interface BackupManifestV1 {
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  appDb: { file: "app.snapshot.db"; sha256: string };
  graphDb: { file: "graph.snapshot.db"; sha256: string };
}

interface EvidenceManifestItem {
  hash: string;
  file: string;
  byteSize: number;
  mediaType: string;
}

interface BackupManifestV2 {
  formatVersion: 2;
  backupId: string;
  generationId: string;
  createdAt: string;
  encryption: "NONE_ACCEPTED_RISK";
  appDb: { file: "app.snapshot.db"; sha256: string };
  graphDb: { file: "graph.snapshot.db"; sha256: string };
  evidence: readonly EvidenceManifestItem[];
  quarantineIncluded: false;
}

type BackupManifest = BackupManifestV1 | BackupManifestV2;

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeRelative(value: string): string {
  const normalized = normalize(value).replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/../")) throw new Error("备份包含不安全的证据路径");
  return normalized;
}

function snapshotEvidence(snapshotPath: string): EvidenceManifestItem[] {
  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const table = snapshot.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'evd_content_object'").get() as { count: number };
    if (table.count === 0) return [];
    return (snapshot.prepare(`SELECT DISTINCT o.hash, o.relative_path, o.byte_size, o.media_type
      FROM evd_content_object o JOIN evd_revision r ON r.content_hash = o.hash ORDER BY o.hash`).all() as Array<{
      hash: string; relative_path: string; byte_size: number; media_type: string;
    }>).map((row) => ({
      hash: row.hash, file: `evidence/${safeRelative(row.relative_path)}`, byteSize: row.byte_size, mediaType: row.media_type,
    }));
  } finally { snapshot.close(); }
}

export async function createBackup(
  dataDir: string,
  db: DbClient,
  graph: GraphClient,
  runtime?: RuntimeAuditService,
  actor?: ActorSnapshot,
  output?: string,
): Promise<string> {
  const backupId = randomUUID(); const generationId = randomUUID();
  const root = resolve(output ?? join(dataPaths(dataDir).backupsDir, new Date().toISOString().replaceAll(":", "-")));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const appSnapshot = join(root, "app.snapshot.db"); const graphSnapshot = join(root, "graph.snapshot.db");
  await db.backup(appSnapshot);
  const health = await verifyDatabaseSnapshot(appSnapshot);
  if (health.quickCheck !== "ok" || (health.foreignKeyIssues as unknown[]).length > 0) throw new Error("备份数据库完整性检查失败");

  const paths = dataPaths(dataDir); const evidence = snapshotEvidence(appSnapshot);
  for (const item of evidence) {
    const sourceRelative = item.file.slice("evidence/".length); const source = join(paths.evidenceDir, sourceRelative); const destination = join(root, item.file);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(source, destination);
    if (await fileHash(destination) !== item.hash) throw new Error(`证据备份Hash校验失败: ${item.hash}`);
  }
  await graph.backup(graphSnapshot);
  const manifest: BackupManifestV2 = {
    formatVersion: 2, backupId, generationId, createdAt: new Date().toISOString(), encryption: "NONE_ACCEPTED_RISK",
    appDb: { file: "app.snapshot.db", sha256: await fileHash(appSnapshot) },
    graphDb: { file: "graph.snapshot.db", sha256: await fileHash(graphSnapshot) }, evidence, quarantineIncluded: false,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`; const temporaryManifest = join(root, `backup-manifest.${generationId}.tmp`);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(temporaryManifest, manifestText, { mode: 0o600 }));
  await rename(temporaryManifest, join(root, "backup-manifest.json"));
  const manifestHash = createHash("sha256").update(manifestText).digest("hex");
  if (runtime && actor) await runtime.recordBackup(actor, backupId, root, manifestHash);
  return root;
}

async function readManifest(root: string): Promise<BackupManifest> {
  const value = JSON.parse(await readFile(join(root, "backup-manifest.json"), "utf8")) as Partial<BackupManifest>;
  if (value.formatVersion !== 1 && value.formatVersion !== 2) throw new Error("不支持的备份格式");
  return value as BackupManifest;
}

export async function restoreBackup(dataDir: string, backupDir: string): Promise<string> {
  const backupRoot = resolve(backupDir); const manifest = await readManifest(backupRoot);
  const appSource = join(backupRoot, basename(manifest.appDb.file)); const graphSource = join(backupRoot, basename(manifest.graphDb.file));
  if (await fileHash(appSource) !== manifest.appDb.sha256 || await fileHash(graphSource) !== manifest.graphDb.sha256) throw new Error("备份文件哈希校验失败");
  const appHealth = await verifyDatabaseSnapshot(appSource);
  if (appHealth.quickCheck !== "ok" || (appHealth.foreignKeyIssues as unknown[]).length > 0) throw new Error("备份数据库完整性检查失败");
  const schemaVersion = Number(appHealth.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > APP_SCHEMA_VERSION) throw new Error(`不支持的备份Schema版本: ${String(appHealth.schemaVersion)}`);
  if (!Array.isArray(appHealth.moduleMigrations)) throw new Error("备份迁移账本格式无效");
  validateMigrationLedger(appHealth.moduleMigrations as Array<{ id: string; module: string; version: number; checksum: string }>);
  const checkGraph = new GraphClient(graphSource); await checkGraph.start();
  const graphHealth = await checkGraph.health(); await checkGraph.close();
  if (graphHealth.ready !== true || graphHealth.quickCheck !== "ok") throw new Error("Graph备份完整性检查失败");

  const paths = dataPaths(dataDir); const suffix = new Date().toISOString().replaceAll(":", "-"); const restoreId = randomUUID();
  const appStage = `${paths.appDb}.restore-${restoreId}`; const graphStage = `${paths.graphDb}.restore-${restoreId}`; const evidenceStage = `${paths.evidenceDir}.restore-${restoreId}`;
  await copyFile(appSource, appStage); await copyFile(graphSource, graphStage);
  await mkdir(join(evidenceStage, "objects", "sha256"), { recursive: true, mode: 0o700 });
  await mkdir(join(evidenceStage, "staging"), { recursive: true, mode: 0o700 }); await mkdir(join(evidenceStage, "quarantine"), { recursive: true, mode: 0o700 });
  if (manifest.formatVersion === 2) {
    for (const item of manifest.evidence) {
      const relative = safeRelative(item.file); if (!relative.startsWith("evidence/objects/")) throw new Error("备份证据路径不合法");
      const source = join(backupRoot, relative); const targetRelative = relative.slice("evidence/".length); const target = join(evidenceStage, targetRelative);
      if (!resolve(target).startsWith(`${resolve(evidenceStage)}${sep}`)) throw new Error("备份证据路径越界");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source, target);
      if (await fileHash(target) !== item.hash) throw new Error(`证据恢复Hash校验失败: ${item.hash}`);
    }
  }

  const appPrevious = `${paths.appDb}.pre-restore-${suffix}`; const graphPrevious = `${paths.graphDb}.pre-restore-${suffix}`; const evidencePrevious = `${paths.evidenceDir}.pre-restore-${suffix}`;
  let appHadPrevious = false; let graphHadPrevious = false; let evidenceHadPrevious = false;
  let appInstalled = false; let graphInstalled = false; let evidenceInstalled = false;
  const moveExisting = async (source: string, destination: string): Promise<boolean> => {
    try { await rename(source, destination); return true; }
    catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  };
  try {
    appHadPrevious = await moveExisting(paths.appDb, appPrevious); graphHadPrevious = await moveExisting(paths.graphDb, graphPrevious);
    evidenceHadPrevious = await moveExisting(paths.evidenceDir, evidencePrevious);
    await rename(appStage, paths.appDb); appInstalled = true; await rename(graphStage, paths.graphDb); graphInstalled = true;
    await rename(evidenceStage, paths.evidenceDir); evidenceInstalled = true;
  } catch (error: unknown) {
    if (appInstalled) await rm(paths.appDb, { force: true }); if (graphInstalled) await rm(paths.graphDb, { force: true });
    if (evidenceInstalled) await rm(paths.evidenceDir, { recursive: true, force: true });
    if (appHadPrevious) await rename(appPrevious, paths.appDb); if (graphHadPrevious) await rename(graphPrevious, paths.graphDb);
    if (evidenceHadPrevious) await rename(evidencePrevious, paths.evidenceDir);
    throw error;
  } finally {
    await rm(appStage, { force: true }); await rm(graphStage, { force: true }); await rm(evidenceStage, { recursive: true, force: true });
  }
  return manifest.backupId;
}
