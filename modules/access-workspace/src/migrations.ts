import type { ModuleMigration } from "@agent-voucher/shared-kernel";

export const accessWorkspaceMigrations = [
  {
    module: "access-workspace",
    id: "a01-foundation-v1",
    version: 1,
    dependsOn: [],
    upSql: `
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
) STRICT;`,
  },
] as const satisfies readonly ModuleMigration[];
