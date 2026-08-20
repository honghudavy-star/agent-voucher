import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import type { RuntimeAuditService } from "@agent-voucher/runtime-audit";
import { verifyDatabaseSnapshot, type DbClient } from "../infrastructure/db/client.js";
import { GraphClient } from "../infrastructure/graph/client.js";
import { dataPaths } from "./paths.js";

interface BackupManifest {
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  appDb: { file: "app.snapshot.db"; sha256: string };
  graphDb: { file: "graph.snapshot.db"; sha256: string };
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function createBackup(
  dataDir: string,
  db: DbClient,
  graph: GraphClient,
  runtime?: RuntimeAuditService,
  actor?: ActorSnapshot,
  output?: string,
): Promise<string> {
  const backupId = randomUUID();
  const root = resolve(output ?? join(dataPaths(dataDir).backupsDir, new Date().toISOString().replaceAll(":", "-")));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const appSnapshot = join(root, "app.snapshot.db");
  const graphSnapshot = join(root, "graph.snapshot.db");
  await db.backup(appSnapshot);
  await graph.backup(graphSnapshot);
  const health = await verifyDatabaseSnapshot(appSnapshot);
  if (health.quickCheck !== "ok" || (health.foreignKeyIssues as unknown[]).length > 0) throw new Error("备份数据库完整性检查失败");
  const manifest: BackupManifest = {
    formatVersion: 1, backupId, createdAt: new Date().toISOString(),
    appDb: { file: "app.snapshot.db", sha256: await fileHash(appSnapshot) },
    graphDb: { file: "graph.snapshot.db", sha256: await fileHash(graphSnapshot) },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(root, "backup-manifest.json"), manifestText, { mode: 0o600 });
  const manifestHash = createHash("sha256").update(manifestText).digest("hex");
  if (runtime && actor) await runtime.recordBackup(actor, backupId, root, manifestHash);
  return root;
}

export async function restoreBackup(dataDir: string, backupDir: string): Promise<string> {
  const backupRoot = resolve(backupDir);
  const manifest = JSON.parse(await readFile(join(backupRoot, "backup-manifest.json"), "utf8")) as BackupManifest;
  if (manifest.formatVersion !== 1) throw new Error("不支持的备份格式");
  const appSource = join(backupRoot, basename(manifest.appDb.file));
  const graphSource = join(backupRoot, basename(manifest.graphDb.file));
  if (await fileHash(appSource) !== manifest.appDb.sha256 || await fileHash(graphSource) !== manifest.graphDb.sha256) {
    throw new Error("备份文件哈希校验失败");
  }
  await verifyDatabaseSnapshot(appSource);
  const checkGraph = new GraphClient(graphSource);
  await checkGraph.start(); await checkGraph.health(); await checkGraph.close();

  const paths = dataPaths(dataDir);
  const suffix = new Date().toISOString().replaceAll(":", "-");
  const appStage = `${paths.appDb}.restore-${randomUUID()}`;
  const graphStage = `${paths.graphDb}.restore-${randomUUID()}`;
  await copyFile(appSource, appStage); await copyFile(graphSource, graphStage);
  const appPrevious = `${paths.appDb}.pre-restore-${suffix}`;
  const graphPrevious = `${paths.graphDb}.pre-restore-${suffix}`;
  let appHadPrevious = false; let graphHadPrevious = false;
  let appInstalled = false; let graphInstalled = false;
  const moveExisting = async (source: string, destination: string): Promise<boolean> => {
    try { await rename(source, destination); return true; }
    catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  };
  try {
    appHadPrevious = await moveExisting(paths.appDb, appPrevious);
    graphHadPrevious = await moveExisting(paths.graphDb, graphPrevious);
    await rename(appStage, paths.appDb); appInstalled = true;
    await rename(graphStage, paths.graphDb); graphInstalled = true;
  } catch (error: unknown) {
    if (appInstalled) await rm(paths.appDb, { force: true });
    if (graphInstalled) await rm(paths.graphDb, { force: true });
    if (appHadPrevious) await rename(appPrevious, paths.appDb);
    if (graphHadPrevious) await rename(graphPrevious, paths.graphDb);
    throw error;
  } finally {
    await rm(appStage, { force: true }); await rm(graphStage, { force: true });
  }
  return manifest.backupId;
}
