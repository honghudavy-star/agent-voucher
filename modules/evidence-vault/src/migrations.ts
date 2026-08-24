import type { ModuleMigration } from "@agent-voucher/shared-kernel";

export const evidenceVaultMigrations = [
  {
    module: "evidence-vault",
    id: "a04-evidence-v1",
    version: 1,
    dependsOn: ["a02-job-runner-v2"],
    upSql: `
CREATE TABLE IF NOT EXISTS evd_content_object (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS evd_evidence (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('BANK_STATEMENT','INVOICE','CONTRACT_FILE','APPROVAL')),
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE','TOMBSTONED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS evd_revision (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evd_evidence(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  content_hash TEXT NOT NULL REFERENCES evd_content_object(hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('LOCAL_UPLOAD','FEISHU')),
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE','TOMBSTONE')),
  source_ref TEXT,
  source_revision TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(evidence_id, revision_no),
  UNIQUE(source_kind, source_ref, source_revision)
) STRICT;
CREATE INDEX IF NOT EXISTS evd_revision_evidence_idx ON evd_revision(evidence_id, revision_no DESC);
CREATE TRIGGER IF NOT EXISTS evd_revision_immutable_update
BEFORE UPDATE ON evd_revision BEGIN SELECT RAISE(ABORT, 'EVIDENCE_REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS evd_revision_immutable_delete
BEFORE DELETE ON evd_revision BEGIN SELECT RAISE(ABORT, 'EVIDENCE_REVISION_IMMUTABLE'); END;
CREATE TABLE IF NOT EXISTS evd_import_occurrence (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evd_evidence(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES evd_revision(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_hash TEXT NOT NULL REFERENCES evd_content_object(hash) ON UPDATE RESTRICT ON DELETE RESTRICT,
  duplicate_of_evidence_id TEXT REFERENCES evd_evidence(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('LOCAL_UPLOAD','FEISHU')),
  source_ref TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('STORED','PHYSICAL_DUPLICATE')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS evd_import_hash_idx ON evd_import_occurrence(content_hash, created_at);
CREATE TRIGGER IF NOT EXISTS evd_import_occurrence_immutable_update
BEFORE UPDATE ON evd_import_occurrence BEGIN SELECT RAISE(ABORT, 'EVIDENCE_OCCURRENCE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS evd_import_occurrence_immutable_delete
BEFORE DELETE ON evd_import_occurrence BEGIN SELECT RAISE(ABORT, 'EVIDENCE_OCCURRENCE_IMMUTABLE'); END;
CREATE TABLE IF NOT EXISTS evd_source_link (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evd_evidence(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('LOCAL_UPLOAD','FEISHU')),
  source_ref TEXT NOT NULL,
  source_revision TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(source_kind, source_ref, source_revision)
) STRICT;
CREATE TABLE IF NOT EXISTS evd_quarantine (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  relative_path TEXT,
  reason TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PURGED')),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS evd_quarantine_expiry_idx ON evd_quarantine(status, expires_at);`,
  },
] as const satisfies readonly ModuleMigration[];
