export const APP_SCHEMA_VERSION = 1;

export const schemaSql = `
CREATE TABLE IF NOT EXISTS ops_schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cfg_workspace (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  accounting_standard TEXT NOT NULL CHECK (accounting_standard = 'CAS'),
  currency TEXT NOT NULL CHECK (currency = 'CNY'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cfg_ledger (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  workspace_id TEXT NOT NULL REFERENCES cfg_workspace(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS iam_user (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(username) BETWEEN 3 AND 64),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS iam_user_role (
  user_id TEXT NOT NULL REFERENCES iam_user(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','OPERATOR','REVIEWER')),
  PRIMARY KEY (user_id, role)
) STRICT;

CREATE TABLE IF NOT EXISTS iam_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES iam_user(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS iam_session_token_idx ON iam_session(token_hash);

CREATE TABLE IF NOT EXISTS cfg_accounting_period (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL UNIQUE CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mst_supplier (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mst_bank_account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_tail TEXT NOT NULL CHECK (length(account_tail) BETWEEN 2 AND 8),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mst_account (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mst_expense_whitelist (
  account_id TEXT PRIMARY KEY REFERENCES mst_account(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL
) STRICT;

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
) STRICT;
`;
