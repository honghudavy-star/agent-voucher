import { createHash } from "node:crypto";
import type { ModuleMigration } from "@agent-voucher/shared-kernel";

const statements = [
  `CREATE TABLE IF NOT EXISTS conn_connector (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type = 'FEISHU'),
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED', 'REAUTH_REQUIRED')),
    secret_ref TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS conn_feishu_config (
    connector_id TEXT PRIMARY KEY REFERENCES conn_connector(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    approval_codes_json TEXT NOT NULL CHECK (json_valid(approval_codes_json)),
    attachment_control_ids_json TEXT NOT NULL CHECK (json_valid(attachment_control_ids_json)),
    initial_lookback_from TEXT NOT NULL,
    daily_sync_time TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    overlap_hours INTEGER NOT NULL DEFAULT 48 CHECK (overlap_hours = 48),
    high_watermark_ms TEXT,
    in_flight_page_token TEXT,
    last_scheduled_local_date TEXT,
    last_success_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS src_sync_batch (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL REFERENCES conn_connector(id),
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('SCHEDULED', 'MANUAL', 'STARTUP_CATCHUP', 'RECONCILIATION')),
    status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'REAUTH_REQUIRED', 'FAILED', 'CANCELED')),
    window_start_ms TEXT,
    window_end_ms TEXT,
    page_token TEXT,
    discovered_count INTEGER NOT NULL DEFAULT 0,
    archived_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    last_error_code TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS src_source_item (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL REFERENCES conn_connector(id),
    sync_batch_id TEXT REFERENCES src_sync_batch(id),
    external_id TEXT NOT NULL,
    approval_code TEXT NOT NULL,
    remote_status TEXT NOT NULL,
    remote_revision_hash TEXT NOT NULL,
    source_status TEXT NOT NULL CHECK (source_status IN ('DISCOVERED', 'FETCHING', 'ARCHIVED', 'PARTIAL', 'REAUTH_REQUIRED', 'FAILED')),
    form_evidence_revision_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    observed_at TEXT NOT NULL,
    archived_at TEXT,
    last_error_code TEXT,
    UNIQUE (connector_id, external_id, remote_revision_hash)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS src_source_item_connector_external_idx
    ON src_source_item(connector_id, external_id, observed_at DESC)`,
  `CREATE TABLE IF NOT EXISTS src_source_attachment (
    id TEXT PRIMARY KEY,
    source_item_id TEXT NOT NULL REFERENCES src_source_item(id),
    control_id TEXT NOT NULL,
    remote_path_hash TEXT NOT NULL,
    evidence_revision_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('DISCOVERED', 'ARCHIVED', 'FAILED')),
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (source_item_id, control_id, remote_path_hash)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS src_tombstone (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL REFERENCES conn_connector(id),
    external_id TEXT NOT NULL,
    previous_remote_revision_hash TEXT,
    remote_status TEXT NOT NULL CHECK (remote_status IN ('CANCELED', 'DELETED', 'REVERTED')),
    observed_at TEXT NOT NULL,
    evidence_revision_id TEXT,
    UNIQUE (connector_id, external_id, remote_status, observed_at)
  ) STRICT`,
] as const;

export const onlineAcquisitionMigrations = [
  {
    module: "online-acquisition",
    id: "a03-online-acquisition-v1",
    version: 1,
    dependsOn: ["a02-job-runner-v2"],
    upSql: `${statements.join(";\n")} ;`,
  },
  {
    module: "online-acquisition",
    id: "a03-reconciliation-v2",
    version: 2,
    dependsOn: ["a03-online-acquisition-v1"],
    upSql: "ALTER TABLE conn_feishu_config ADD COLUMN reconciliation_cursor_external_id TEXT;",
  },
  {
    module: "online-acquisition",
    id: "a03-page-checkpoint-v3",
    version: 3,
    dependsOn: ["a03-reconciliation-v2"],
    upSql: "ALTER TABLE conn_feishu_config ADD COLUMN in_flight_approval_code TEXT;",
  },
  {
    module: "online-acquisition",
    id: "a03-feishu-platform-v4",
    version: 4,
    dependsOn: ["a03-page-checkpoint-v3"],
    upSql: "ALTER TABLE conn_feishu_config ADD COLUMN platform TEXT NOT NULL DEFAULT 'FEISHU' CHECK (platform IN ('FEISHU','LARK'));",
  },
  {
    module: "online-acquisition",
    id: "a03-processed-config-revision-v5",
    version: 5,
    dependsOn: ["a03-feishu-platform-v4"],
    upSql: "ALTER TABLE src_source_item ADD COLUMN processed_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (processed_config_revision >= 1);",
  },
] as const satisfies readonly ModuleMigration[];

export const ONLINE_ACQUISITION_MIGRATION_V1 = Object.freeze({
  module: "online-acquisition" as const,
  version: 1 as const,
  dependencies: [{ module: "runtime-audit", minimumVersion: 2 }] as const,
  checksum: createHash("sha256").update(statements.join("\n-- statement --\n")).digest("hex"),
  upSql: statements,
});
