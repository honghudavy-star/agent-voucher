import type { ModuleMigration } from "@agent-voucher/shared-kernel";

export const runtimeAuditMigrations = [
  {
    module: "runtime-audit",
    id: "a02-foundation-v1",
    version: 1,
    dependsOn: ["a01-foundation-v1"],
    upSql: `
CREATE TABLE IF NOT EXISTS job_task (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','WAITING_REVIEW','SUCCEEDED','FAILED','CANCELLED')),
  dedupe_key TEXT UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS job_task_status_idx ON job_task(status, created_at);
CREATE TABLE IF NOT EXISTS prc_process_instance (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  thread_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED')),
  state_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS aud_event (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  actor_roles_json TEXT NOT NULL,
  ip_address TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  before_revision INTEGER,
  after_revision INTEGER,
  result TEXT NOT NULL CHECK (result IN ('SUCCESS','REJECTED','FAILED')),
  correlation_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS aud_event_time_idx ON aud_event(occurred_at DESC);
CREATE TRIGGER IF NOT EXISTS aud_event_immutable_update
BEFORE UPDATE ON aud_event BEGIN SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS aud_event_immutable_delete
BEFORE DELETE ON aud_event BEGIN SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE'); END;
CREATE TABLE IF NOT EXISTS ops_backup (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATING','VERIFIED','FAILED')),
  created_at TEXT NOT NULL,
  verified_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS ops_idempotency (
  key TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;`,
  },
  {
    module: "runtime-audit",
    id: "a02-job-runner-v2",
    version: 2,
    dependsOn: ["a02-foundation-v1"],
    upSql: `
ALTER TABLE job_task ADD COLUMN lane TEXT NOT NULL DEFAULT 'MAINTENANCE' CHECK (lane IN ('NETWORK','PARSER','MAINTENANCE'));
ALTER TABLE job_task ADD COLUMN requested_by_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE job_task ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE job_task ADD COLUMN cancel_requested_at TEXT;
DROP INDEX IF EXISTS job_task_status_idx;
CREATE INDEX job_task_status_idx ON job_task(status, lane, created_at);`,
  },
  {
    module: "runtime-audit",
    id: "a02-job-retry-schedule-v3",
    version: 3,
    dependsOn: ["a02-job-runner-v2"],
    upSql: "ALTER TABLE job_task ADD COLUMN next_attempt_at TEXT;",
  },
] as const satisfies readonly ModuleMigration[];
