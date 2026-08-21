import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { accessWorkspaceMigrations } from "@agent-voucher/access-workspace";
import { runtimeAuditMigrations } from "@agent-voucher/runtime-audit";
import { onlineAcquisitionMigrations } from "@agent-voucher/online-acquisition";
import { evidenceVaultMigrations } from "@agent-voucher/evidence-vault";
import { documentUnderstandingMigrations } from "@agent-voucher/document-understanding";
import type { MigrationManifest, ModuleMigration } from "@agent-voucher/shared-kernel";

export const APP_SCHEMA_VERSION = 2;

const migrationLedgerSql = `
CREATE TABLE IF NOT EXISTS ops_schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS ops_module_migration (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE(module, version)
) STRICT;`;

function checksum(migration: ModuleMigration): string {
  return createHash("sha256").update(JSON.stringify({
    module: migration.module,
    id: migration.id,
    version: migration.version,
    dependsOn: migration.dependsOn,
    upSql: migration.upSql.trim(),
  })).digest("hex");
}

export function createMigrationManifest(migration: ModuleMigration): MigrationManifest {
  return { ...migration, checksum: checksum(migration) };
}

export function foundationMigrations(extra: readonly ModuleMigration[] = []): readonly MigrationManifest[] {
  return [
    ...accessWorkspaceMigrations,
    ...runtimeAuditMigrations,
    ...onlineAcquisitionMigrations,
    ...evidenceVaultMigrations,
    ...documentUnderstandingMigrations,
    ...extra,
  ].map(createMigrationManifest);
}

export interface AppliedMigrationRow {
  id: string;
  module: string;
  version: number;
  checksum: string;
}

export function validateMigrationLedger(
  appliedRows: readonly AppliedMigrationRow[],
  migrations: readonly MigrationManifest[] = foundationMigrations(),
): void {
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const applied of appliedRows) {
    const migration = known.get(applied.id);
    if (!migration) throw new Error(`UNKNOWN_SCHEMA_MIGRATION:${applied.id}`);
    if (migration.module !== applied.module || migration.version !== applied.version || migration.checksum !== applied.checksum) {
      throw new Error(`MIGRATION_CHECKSUM_DRIFT:${applied.id}`);
    }
  }
}

export async function applyModuleMigrations(
  db: Database.Database,
  databasePath: string,
  migrations: readonly MigrationManifest[],
): Promise<void> {
  db.exec(migrationLedgerSql);
  const legacyVersion = db.prepare("SELECT max(version) AS version FROM ops_schema_migration").get() as { version: number | null };
  if (legacyVersion.version !== null && legacyVersion.version > APP_SCHEMA_VERSION) {
    throw new Error(`UNKNOWN_NEWER_SCHEMA:${String(legacyVersion.version)}`);
  }
  const appliedRows = db.prepare("SELECT id, module, version, checksum FROM ops_module_migration ORDER BY applied_at")
    .all() as AppliedMigrationRow[];
  validateMigrationLedger(appliedRows, migrations);

  const appliedIds = new Set(appliedRows.map((row) => row.id));
  const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
  if (pending.length === 0) return;

  const tableCount = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { count: number };
  if (tableCount.count > 2) {
    const suffix = new Date().toISOString().replaceAll(":", "-");
    await db.backup(`${databasePath}.pre-migrate-${suffix}.db`);
  }

  for (const migration of pending) {
    const missing = migration.dependsOn.filter((dependency) => !appliedIds.has(dependency));
    if (missing.length > 0) throw new Error(`MIGRATION_DEPENDENCY_MISSING:${migration.id}:${missing.join(",")}`);
    db.transaction(() => {
      db.exec(migration.upSql);
      db.prepare(`INSERT INTO ops_module_migration(id, module, version, checksum, applied_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(migration.id, migration.module, migration.version, migration.checksum, new Date().toISOString());
    })();
    appliedIds.add(migration.id);
  }

  db.prepare("INSERT OR REPLACE INTO ops_schema_migration(version, applied_at) VALUES (?, ?)")
    .run(APP_SCHEMA_VERSION, new Date().toISOString());
}
