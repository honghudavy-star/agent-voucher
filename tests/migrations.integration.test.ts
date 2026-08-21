import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { accessWorkspaceMigrations } from "@agent-voucher/access-workspace";
import { runtimeAuditMigrations } from "@agent-voucher/runtime-audit";
import { DbClient } from "../src/infrastructure/db/client.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

describe("module migration coordinator", () => {
  it("upgrades a legacy v1 database, records checksums and creates a pre-migration snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-migrate-")); const paths = await prepareDataDir(root);
    try {
      const legacy = new Database(paths.appDb);
      legacy.exec(`CREATE TABLE ops_schema_migration(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
        INSERT INTO ops_schema_migration(version, applied_at) VALUES (1, '2026-08-20T00:00:00.000Z');
        ${accessWorkspaceMigrations[0].upSql}
        ${runtimeAuditMigrations[0].upSql}`);
      legacy.close();
      const client = new DbClient(paths.appDb); await client.start();
      const health = await client.health(); const migrations = health.moduleMigrations as Array<{ id: string; checksum: string }>;
      expect(migrations.map((item) => item.id)).toEqual(expect.arrayContaining([
        "a01-foundation-v1", "a02-foundation-v1", "a02-job-runner-v2", "a03-online-acquisition-v1", "a04-evidence-v1", "a05-document-understanding-v1",
      ]));
      expect(migrations.every((item) => /^[a-f0-9]{64}$/.test(item.checksum))).toBe(true);
      const columns = await client.read<Array<{ name: string }>>({ sql: "PRAGMA table_info(job_task)", mode: "all" });
      expect(columns.map((item) => item.name)).toEqual(expect.arrayContaining(["lane", "requested_by_json", "last_heartbeat_at", "cancel_requested_at", "next_attempt_at"]));
      await client.close();
      expect((await readdir(paths.dbDir)).some((name) => name.includes("pre-migrate"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when an applied migration checksum drifts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-migrate-drift-")); const paths = await prepareDataDir(root);
    try {
      const first = new DbClient(paths.appDb); await first.start(); await first.close();
      const raw = new Database(paths.appDb); raw.prepare("UPDATE ops_module_migration SET checksum = ? WHERE id = ?").run("0".repeat(64), "a04-evidence-v1"); raw.close();
      const second = new DbClient(paths.appDb);
      await expect(second.start()).rejects.toThrow(/MIGRATION_CHECKSUM_DRIFT/);
      await second.close().catch(() => undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a legacy schema version newer than this binary understands", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-migrate-newer-")); const paths = await prepareDataDir(root);
    try {
      const raw = new Database(paths.appDb);
      raw.exec("CREATE TABLE ops_schema_migration(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
      raw.prepare("INSERT INTO ops_schema_migration(version, applied_at) VALUES (999, ?)").run(new Date().toISOString()); raw.close();
      const client = new DbClient(paths.appDb);
      await expect(client.start()).rejects.toThrow(/UNKNOWN_NEWER_SCHEMA:999/);
      await client.close().catch(() => undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
