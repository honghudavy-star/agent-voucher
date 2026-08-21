import { createHash } from "node:crypto";
import type { MigrationManifest, ModuleMigration } from "@agent-voucher/shared-kernel";

const DOCUMENT_UNDERSTANDING_SQL = `
CREATE TABLE IF NOT EXISTS doc_mapping_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('CSV','SPREADSHEET')),
  active_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS doc_mapping_revision (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES doc_mapping_profile(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  header_signature TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  actor_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, revision)
) STRICT;

CREATE TRIGGER IF NOT EXISTS doc_mapping_revision_immutable_update
BEFORE UPDATE ON doc_mapping_revision BEGIN SELECT RAISE(ABORT, 'DOC_REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS doc_mapping_revision_immutable_delete
BEFORE DELETE ON doc_mapping_revision BEGIN SELECT RAISE(ABORT, 'DOC_REVISION_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS doc_bank_import (
  id TEXT PRIMARY KEY,
  evidence_revision_id TEXT NOT NULL,
  mapping_revision_id TEXT NOT NULL REFERENCES doc_mapping_revision(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parser_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','PARSED','VALIDATED','NEEDS_REVIEW','OVERRIDDEN_UNREVIEWED','FAILED')),
  first_error_source_row INTEGER,
  override_reason TEXT,
  override_actor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS doc_bank_import_evidence_idx ON doc_bank_import(evidence_revision_id);

CREATE TABLE IF NOT EXISTS doc_bank_transaction (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES doc_bank_import(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_row INTEGER NOT NULL CHECK (source_row >= 1),
  active_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  UNIQUE(import_id, source_row)
) STRICT;

CREATE TABLE IF NOT EXISTS doc_bank_transaction_revision (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES doc_bank_transaction(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  previous_revision_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('IMPORT','CORRECTION','SOFT_DELETE','RESTORE')),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  deleted INTEGER NOT NULL CHECK (deleted IN (0,1)),
  reason TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(transaction_id, revision)
) STRICT;

CREATE TRIGGER IF NOT EXISTS doc_bank_transaction_revision_immutable_update
BEFORE UPDATE ON doc_bank_transaction_revision BEGIN SELECT RAISE(ABORT, 'DOC_REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS doc_bank_transaction_revision_immutable_delete
BEFORE DELETE ON doc_bank_transaction_revision BEGIN SELECT RAISE(ABORT, 'DOC_REVISION_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS doc_invoice_extraction (
  id TEXT PRIMARY KEY,
  evidence_revision_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('VALIDATED','NEEDS_REVIEW','OCR_REQUIRED','PARTIAL_TEXT','UNSUPPORTED_LAYOUT','PASSWORD_PROTECTED','CORRUPT_PDF','FAILED')),
  validation_errors_json TEXT NOT NULL CHECK (json_valid(validation_errors_json)),
  active_revision INTEGER NOT NULL DEFAULT 1 CHECK (active_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS doc_invoice_extraction_evidence_idx ON doc_invoice_extraction(evidence_revision_id);

CREATE TABLE IF NOT EXISTS doc_invoice_field_revision (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL REFERENCES doc_invoice_extraction(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  field_name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  previous_revision_id TEXT,
  raw_text TEXT NOT NULL,
  normalized_value_json TEXT CHECK (normalized_value_json IS NULL OR json_valid(normalized_value_json)),
  source_page INTEGER NOT NULL CHECK (source_page >= 1),
  source_position_json TEXT NOT NULL CHECK (json_valid(source_position_json)),
  validation_errors_json TEXT NOT NULL CHECK (json_valid(validation_errors_json)),
  reason TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(extraction_id, field_name, revision)
) STRICT;

CREATE TRIGGER IF NOT EXISTS doc_invoice_field_revision_immutable_update
BEFORE UPDATE ON doc_invoice_field_revision BEGIN SELECT RAISE(ABORT, 'DOC_REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS doc_invoice_field_revision_immutable_delete
BEFORE DELETE ON doc_invoice_field_revision BEGIN SELECT RAISE(ABORT, 'DOC_REVISION_IMMUTABLE'); END;
`;

const migration = Object.freeze({
  module: "document-understanding",
  id: "a05-document-understanding-v1",
  version: 1,
  dependsOn: ["a04-evidence-v1"],
  upSql: DOCUMENT_UNDERSTANDING_SQL,
}) satisfies ModuleMigration;

const checksum = createHash("sha256").update(JSON.stringify({
  module: migration.module,
  id: migration.id,
  version: migration.version,
  dependsOn: migration.dependsOn,
  upSql: migration.upSql.trim(),
})).digest("hex");

export const documentUnderstandingMigration = Object.freeze({
  ...migration,
  checksum,
}) satisfies MigrationManifest;

const mappingVisibilityMigration = Object.freeze({
  module: "document-understanding",
  id: "a05-mapping-visibility-v2",
  version: 2,
  dependsOn: ["a05-document-understanding-v1"],
  upSql: `ALTER TABLE doc_mapping_profile ADD COLUMN visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','SHARED'));
ALTER TABLE doc_mapping_profile ADD COLUMN owner_actor_id TEXT;`,
}) satisfies ModuleMigration;

export const documentUnderstandingMigrations = Object.freeze([migration, mappingVisibilityMigration]) satisfies readonly ModuleMigration[];
