import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { ActorSnapshot, DatabasePort, SqlStatement, WriteCommand } from "@agent-voucher/shared-kernel";
import { newId, nowIso, requireRole } from "@agent-voucher/shared-kernel";
import { BankMappingProfileSchema, type BankMappingProfile } from "./bank.js";
import { validateBankRows } from "./bank.js";
import { InvoiceFieldSchema, InvoiceExtractionStatusSchema, validateInvoiceFieldValues, type InvoiceField } from "./invoice.js";
import { runParserSubprocess, type ParserLauncherOptions, ParserProcessError } from "./parser-launcher.js";
import { type EvidenceRevisionId } from "./contracts.js";

const BankParsedRowSchema = z.object({
  sourceRow: z.number().int().positive(), transactionDate: z.string(), amountCents: z.number().int().safe(),
  balanceCents: z.number().int().safe().nullable(), transactionId: z.string().optional(), currency: z.literal("CNY"),
  counterpartyName: z.string().optional(), counterpartyAccount: z.string().optional(), summary: z.string().optional(),
  accountTail: z.string().optional(), rawCells: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  issues: z.array(z.string()), possibleDuplicate: z.boolean(),
});
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, "invalid calendar date");
const BankEditableRowSchema = z.object({
  transactionDate: IsoDateSchema, amountCents: z.number().int().safe(), balanceCents: z.number().int().safe().nullable(),
  transactionId: z.string().max(256).optional(), currency: z.literal("CNY"), counterpartyName: z.string().max(256).optional(),
  counterpartyAccount: z.string().max(256).optional(), summary: z.string().max(1000).optional(), accountTail: z.string().max(16).optional(),
});
const BankParserResultSchema = z.object({
  parserVersion: z.literal("bank-structured-v1"), headerSignature: z.string().regex(/^[a-f0-9]{64}$/),
  rows: z.array(BankParsedRowSchema).max(100_000),
  validation: z.object({ valid: z.boolean(), firstErrorSourceRow: z.number().int().positive().nullable(), issues: z.array(z.unknown()), affectedSourceRows: z.array(z.number().int().positive()) }),
  preview: z.unknown(),
});
export type BankParserResult = z.infer<typeof BankParserResultSchema>;

const InvoiceParserResultSchema = z.object({
  parserVersion: z.literal("invoice-text-v1"), status: InvoiceExtractionStatusSchema,
  fields: z.array(InvoiceFieldSchema), validationErrors: z.array(z.string()), pageCount: z.number().int().positive().optional(),
});
export type InvoiceParserResult = z.infer<typeof InvoiceParserResultSchema>;

function command(actor: ActorSnapshot, action: string, objectType: string, objectId: string, statements: WriteCommand["statements"], metadata: Record<string, string | number | boolean | null> = {}): WriteCommand {
  return {
    commandId: newId(), commandType: action, commandVersion: 1, correlationId: newId(), actor, statements,
    audit: { action, objectType, objectId, beforeRevision: null, afterRevision: null, result: "SUCCESS", metadata },
  };
}

async function assertContentHash(filePath: string, expected: string): Promise<void> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== expected) throw new Error("EVIDENCE_CONTENT_HASH_MISMATCH");
}

export class DocumentUnderstandingService {
  constructor(private readonly db: DatabasePort, private readonly parser: ParserLauncherOptions) {}

  listMappings(actor?: ActorSnapshot): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: `SELECT p.id, p.name, p.source_kind, p.visibility, p.owner_actor_id, p.active_revision_id, p.created_at, p.updated_at,
      r.revision, r.header_signature, r.config_json FROM doc_mapping_profile p
      LEFT JOIN doc_mapping_revision r ON r.id = p.active_revision_id
      WHERE ? IS NULL OR p.visibility = 'SHARED' OR p.owner_actor_id = ? ORDER BY p.updated_at DESC`,
      params: [actor?.userId ?? null, actor?.userId ?? null], mode: "all" });
  }

  async getMappingRevision(id: string): Promise<{ profile: BankMappingProfile; headerSignature: string } | undefined> {
    const row = await this.db.read<{ config_json: string; header_signature: string } | undefined>({
      sql: "SELECT config_json, header_signature FROM doc_mapping_revision WHERE id = ?", params: [id], mode: "get",
    });
    if (!row) return undefined;
    return { profile: BankMappingProfileSchema.parse(JSON.parse(row.config_json) as unknown), headerSignature: row.header_signature };
  }

  async findMappingByHeaderSignature(actor: ActorSnapshot, headerSignature: string): Promise<{ revisionId: string; profile: BankMappingProfile } | undefined> {
    const row = await this.db.read<{ id: string; config_json: string } | undefined>({
      sql: `SELECT r.id, r.config_json FROM doc_mapping_revision r JOIN doc_mapping_profile p ON p.id = r.profile_id
            WHERE r.header_signature = ? AND (p.visibility = 'SHARED' OR p.owner_actor_id = ?) ORDER BY r.created_at DESC LIMIT 1`,
      params: [headerSignature, actor.userId], mode: "get",
    });
    return row ? { revisionId: row.id, profile: BankMappingProfileSchema.parse(JSON.parse(row.config_json) as unknown) } : undefined;
  }

  async saveMapping(actor: ActorSnapshot, profileInput: BankMappingProfile, headerSignature: string, reason?: string, visibility: "PRIVATE" | "SHARED" = "PRIVATE"): Promise<string> {
    requireRole(actor, "ADMIN", "OPERATOR");
    if (visibility === "SHARED") requireRole(actor, "ADMIN");
    const profile = BankMappingProfileSchema.parse(profileInput); const revisionId = newId(); const timestamp = nowIso();
    const current = await this.db.read<{ active_revision_id: string | null; revision: number | null } | undefined>({
      sql: `SELECT p.active_revision_id, r.revision FROM doc_mapping_profile p
            LEFT JOIN doc_mapping_revision r ON r.id = p.active_revision_id WHERE p.id = ?`, params: [profile.id], mode: "get",
    });
    const revision = (current?.revision ?? 0) + 1;
    await this.db.write(command(actor, "BANK_MAPPING_SAVED", "mapping", profile.id, [
      { sql: `INSERT INTO doc_mapping_profile(id, name, source_kind, active_revision_id, visibility, owner_actor_id, created_at, updated_at)
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
              source_kind = excluded.source_kind, visibility = excluded.visibility, owner_actor_id = excluded.owner_actor_id, updated_at = excluded.updated_at`,
        params: [profile.id, profile.name, profile.sourceKind, visibility, actor.userId, timestamp, timestamp] },
      { sql: `INSERT INTO doc_mapping_revision(id, profile_id, revision, header_signature, config_json, actor_id, reason, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, params: [revisionId, profile.id, revision, headerSignature, JSON.stringify(profile), actor.userId, reason ?? null, timestamp] },
      { sql: "UPDATE doc_mapping_profile SET active_revision_id = ?, updated_at = ? WHERE id = ?", params: [revisionId, timestamp, profile.id], expectChanges: 1 },
    ], { revision, headerSignature }));
    return revisionId;
  }

  async parseBank(context: { evidenceRevisionId: EvidenceRevisionId; filePath: string; contentSha256: string }, profileInput: BankMappingProfile, signal?: AbortSignal): Promise<BankParserResult> {
    const profile = BankMappingProfileSchema.parse(profileInput); await assertContentHash(context.filePath, context.contentSha256); const file = await stat(context.filePath);
    const response = await runParserSubprocess({
      protocolVersion: 1, requestId: newId(), kind: profile.sourceKind === "CSV" ? "BANK_CSV" : "BANK_SPREADSHEET",
      filePath: context.filePath, fileSizeBytes: file.size, config: profile,
    }, { ...this.parser, ...(signal ? { signal } : {}) });
    if (!response.ok) throw new ParserProcessError(response.error.code, response.error.message);
    return BankParserResultSchema.parse(response.result);
  }

  async persistBankImport(
    actor: ActorSnapshot, evidenceRevisionId: EvidenceRevisionId, mappingRevisionId: string, result: BankParserResult,
  ): Promise<string> {
    requireRole(actor, "ADMIN", "OPERATOR");
    const parsed = BankParserResultSchema.parse(result); const timestamp = nowIso();
    const configHash = createHash("sha256").update(`${mappingRevisionId}:${parsed.headerSignature}`).digest("hex");
    const id = createHash("sha256").update(`${evidenceRevisionId}:${mappingRevisionId}:${parsed.parserVersion}:${configHash}`).digest("hex");
    const existing = await this.db.read<{ status: string } | undefined>({ sql: "SELECT status FROM doc_bank_import WHERE id = ?", params: [id], mode: "get" });
    if (existing && existing.status !== "QUEUED") return id;
    await this.db.write(command(actor, "BANK_IMPORT_CREATED", "bank_import", id, [{
      sql: `INSERT INTO doc_bank_import(id, evidence_revision_id, mapping_revision_id, parser_version, config_hash, status,
            first_error_source_row, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'QUEUED', NULL, ?, ?)
            ON CONFLICT(id) DO NOTHING`, params: [
        id, evidenceRevisionId, mappingRevisionId, parsed.parserVersion, configHash, timestamp, timestamp,
      ],
    }], { rowCount: parsed.rows.length, status: "QUEUED" }));
    for (let offset = 0; offset < parsed.rows.length; offset += 250) {
      const statements: SqlStatement[] = [];
      for (const row of parsed.rows.slice(offset, offset + 250)) {
        const transactionId = createHash("sha256").update(`${id}:row:${String(row.sourceRow)}`).digest("hex");
        const revisionId = createHash("sha256").update(`${transactionId}:revision:1`).digest("hex");
        statements.push(
          { sql: `INSERT INTO doc_bank_transaction(id, import_id, source_row, active_revision_id, revision, created_at)
                  VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING`, params: [transactionId, id, row.sourceRow, revisionId, timestamp] },
          { sql: `INSERT INTO doc_bank_transaction_revision(id, transaction_id, revision, previous_revision_id, operation,
                  data_json, deleted, reason, actor_id, created_at) VALUES (?, ?, 1, NULL, 'IMPORT', ?, 0, NULL, ?, ?)
                  ON CONFLICT(id) DO NOTHING`,
            params: [revisionId, transactionId, JSON.stringify(row), actor.userId, timestamp] },
        );
      }
      await this.db.write(command(actor, "BANK_IMPORT_ROWS_STORED", "bank_import", id, statements, { offset, count: statements.length / 2 }));
    }
    const status = parsed.validation.valid ? "VALIDATED" : "NEEDS_REVIEW";
    await this.db.write(command(actor, "BANK_IMPORT_FINALIZED", "bank_import", id, [{
      sql: `UPDATE doc_bank_import SET status = ?, first_error_source_row = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'`,
      params: [status, parsed.validation.firstErrorSourceRow, nowIso(), id], expectChanges: 1,
    }], { rowCount: parsed.rows.length, status }));
    return id;
  }

  async overrideBankImport(actor: ActorSnapshot, id: string, reason: string): Promise<void> {
    requireRole(actor, "ADMIN", "OPERATOR");
    const normalized = reason.trim(); if (!normalized) throw new Error("OVERRIDE_REASON_REQUIRED");
    await this.db.write(command(actor, "BANK_IMPORT_OVERRIDDEN", "bank_import", id, [{
      sql: `UPDATE doc_bank_import SET status = 'OVERRIDDEN_UNREVIEWED', override_reason = ?, override_actor_id = ?, updated_at = ?
            WHERE id = ? AND status = 'NEEDS_REVIEW'`, params: [normalized, actor.userId, nowIso(), id], expectChanges: 1,
    }], { reasonLength: normalized.length }));
  }

  listBankImports(limit = 50): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM doc_bank_import ORDER BY created_at DESC LIMIT ?", params: [limit], mode: "all" });
  }

  listBankTransactions(importId: string): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: `SELECT t.id, t.source_row, t.revision, r.operation, r.data_json, r.deleted, r.reason, r.actor_id, r.created_at
      FROM doc_bank_transaction t JOIN doc_bank_transaction_revision r ON r.id = t.active_revision_id
      WHERE t.import_id = ? ORDER BY t.source_row`, params: [importId], mode: "all" });
  }

  listBankTransactionHistory(importId: string): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: `SELECT t.id AS transaction_id, t.source_row, r.* FROM doc_bank_transaction t
      JOIN doc_bank_transaction_revision r ON r.transaction_id = t.id WHERE t.import_id = ?
      ORDER BY t.source_row, r.revision DESC`, params: [importId], mode: "all" });
  }

  async reviseBankTransaction(actor: ActorSnapshot, transactionId: string, expectedRevision: number, data: unknown, reason: string, deleted = false): Promise<void> {
    requireRole(actor, "ADMIN", "OPERATOR");
    const normalizedReason = reason.trim(); if (!normalizedReason) throw new Error("REVISION_REASON_REQUIRED");
    const current = await this.db.read<{ active_revision_id: string; import_id: string; source_row: number; data_json: string } | undefined>({
      sql: `SELECT t.active_revision_id, t.import_id, t.source_row, r.data_json FROM doc_bank_transaction t
            JOIN doc_bank_transaction_revision r ON r.id = t.active_revision_id WHERE t.id = ?`, params: [transactionId], mode: "get",
    });
    if (!current) throw new Error("BANK_TRANSACTION_NOT_FOUND");
    const original = BankParsedRowSchema.parse(JSON.parse(current.data_json) as unknown);
    const editable = BankEditableRowSchema.parse(data);
    const parsedData = BankParsedRowSchema.parse({
      ...original, ...editable, sourceRow: current.source_row, rawCells: original.rawCells, issues: [], possibleDuplicate: original.possibleDuplicate,
    });
    const revisionId = newId(); const timestamp = nowIso();
    await this.db.write(command(actor, deleted ? "BANK_TRANSACTION_SOFT_DELETED" : "BANK_TRANSACTION_CORRECTED", "bank_transaction", transactionId, [
      { sql: `INSERT INTO doc_bank_transaction_revision(id, transaction_id, revision, previous_revision_id, operation, data_json,
              deleted, reason, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [
        revisionId, transactionId, expectedRevision + 1, current.active_revision_id, deleted ? "SOFT_DELETE" : "CORRECTION",
        JSON.stringify(parsedData), deleted ? 1 : 0, normalizedReason, actor.userId, timestamp,
      ] },
      { sql: `UPDATE doc_bank_transaction SET active_revision_id = ?, revision = revision + 1
              WHERE id = ? AND revision = ?`, params: [revisionId, transactionId, expectedRevision], expectChanges: 1 },
    ], { deleted, reasonLength: normalizedReason.length }));
    await this.recomputeBankImport(actor, current.import_id);
  }

  async addBankTransaction(actor: ActorSnapshot, importId: string, data: unknown, reason: string): Promise<string> {
    requireRole(actor, "ADMIN", "OPERATOR");
    const editable = BankEditableRowSchema.parse(data); const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("REVISION_REASON_REQUIRED");
    const maximum = await this.db.read<{ source_row: number | null }>({
      sql: "SELECT max(source_row) AS source_row FROM doc_bank_transaction WHERE import_id = ?", params: [importId], mode: "get",
    });
    const sourceRow = (maximum.source_row ?? 0) + 1; const transactionId = newId(); const revisionId = newId(); const timestamp = nowIso();
    await this.db.write(command(actor, "BANK_TRANSACTION_ADDED", "bank_import", importId, [
      { sql: `INSERT INTO doc_bank_transaction(id, import_id, source_row, active_revision_id, revision, created_at)
              VALUES (?, ?, ?, ?, 1, ?)`, params: [transactionId, importId, sourceRow, revisionId, timestamp] },
      { sql: `INSERT INTO doc_bank_transaction_revision(id, transaction_id, revision, previous_revision_id, operation, data_json,
              deleted, reason, actor_id, created_at) VALUES (?, ?, 1, NULL, 'CORRECTION', ?, 0, ?, ?, ?)`,
        params: [revisionId, transactionId, JSON.stringify({ ...editable, sourceRow, rawCells: {}, issues: [], possibleDuplicate: false }), normalizedReason, actor.userId, timestamp] },
    ], { sourceRow, reasonLength: normalizedReason.length }));
    await this.recomputeBankImport(actor, importId);
    return transactionId;
  }

  async recomputeBankImport(actor: ActorSnapshot, importId: string): Promise<void> {
    const imported = await this.db.read<{ status: string; config_json: string } | undefined>({
      sql: `SELECT i.status, r.config_json FROM doc_bank_import i JOIN doc_mapping_revision r ON r.id = i.mapping_revision_id WHERE i.id = ?`,
      params: [importId], mode: "get",
    });
    if (!imported) throw new Error("BANK_IMPORT_NOT_FOUND");
    const profile = BankMappingProfileSchema.parse(JSON.parse(imported.config_json) as unknown);
    const rows = await this.listBankTransactions(importId);
    const active = rows.filter((row) => Number(row.deleted) === 0).map((row) => BankParsedRowSchema.parse(JSON.parse(String(row.data_json)) as unknown));
    const validation = validateBankRows(active, profile.order);
    const status = validation.valid ? "VALIDATED" : imported.status === "OVERRIDDEN_UNREVIEWED" ? "OVERRIDDEN_UNREVIEWED" : "NEEDS_REVIEW";
    await this.db.write(command(actor, "BANK_IMPORT_REVALIDATED", "bank_import", importId, [{
      sql: "UPDATE doc_bank_import SET status = ?, first_error_source_row = ?, updated_at = ? WHERE id = ?",
      params: [status, validation.firstErrorSourceRow, nowIso(), importId], expectChanges: 1,
    }], { status, activeRows: active.length }));
  }

  async parseInvoice(context: { evidenceRevisionId: EvidenceRevisionId; filePath: string; contentSha256: string }, signal?: AbortSignal): Promise<InvoiceParserResult> {
    await assertContentHash(context.filePath, context.contentSha256); const file = await stat(context.filePath);
    const response = await runParserSubprocess({ protocolVersion: 1, requestId: newId(), kind: "INVOICE_PDF", filePath: context.filePath, fileSizeBytes: file.size, config: {} }, { ...this.parser, ...(signal ? { signal } : {}) });
    if (!response.ok) throw new ParserProcessError(response.error.code, response.error.message);
    return InvoiceParserResultSchema.parse(response.result);
  }

  async persistInvoiceExtraction(actor: ActorSnapshot, evidenceRevisionId: EvidenceRevisionId, result: InvoiceParserResult): Promise<string> {
    requireRole(actor, "ADMIN", "OPERATOR");
    const parsed = InvoiceParserResultSchema.parse(result); const id = newId(); const timestamp = nowIso();
    const statements: SqlStatement[] = [{
      sql: `INSERT INTO doc_invoice_extraction(id, evidence_revision_id, parser_version, status, validation_errors_json,
            active_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      params: [id, evidenceRevisionId, parsed.parserVersion, parsed.status, JSON.stringify(parsed.validationErrors), timestamp, timestamp],
    }];
    for (const field of parsed.fields) statements.push({
      sql: `INSERT INTO doc_invoice_field_revision(id, extraction_id, field_name, revision, previous_revision_id, raw_text,
            normalized_value_json, source_page, source_position_json, validation_errors_json, reason, actor_id, created_at)
            VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)`, params: [
        newId(), id, field.name, field.rawText, JSON.stringify(field.normalizedValue), field.page,
        JSON.stringify(field.position), JSON.stringify(field.validationErrors), actor.userId, timestamp,
      ],
    });
    await this.db.write(command(actor, "INVOICE_EXTRACTED", "invoice_extraction", id, statements, { status: parsed.status, fieldCount: parsed.fields.length }));
    return id;
  }

  listInvoiceExtractions(limit = 50): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM doc_invoice_extraction ORDER BY created_at DESC LIMIT ?", params: [limit], mode: "all" });
  }

  listInvoiceFields(extractionId: string): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: `SELECT f.* FROM doc_invoice_field_revision f
      WHERE f.extraction_id = ? AND f.revision = (SELECT max(f2.revision) FROM doc_invoice_field_revision f2
      WHERE f2.extraction_id = f.extraction_id AND f2.field_name = f.field_name) ORDER BY f.field_name`, params: [extractionId], mode: "all" });
  }

  listInvoiceFieldHistory(extractionId: string): Promise<Record<string, unknown>[]> {
    return this.db.read({
      sql: "SELECT * FROM doc_invoice_field_revision WHERE extraction_id = ? ORDER BY field_name, revision DESC",
      params: [extractionId], mode: "all",
    });
  }

  async correctInvoiceField(actor: ActorSnapshot, extractionId: string, field: InvoiceField, reason: string): Promise<void> {
    requireRole(actor, "ADMIN", "OPERATOR");
    const parsed = InvoiceFieldSchema.parse(field); const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("REVISION_REASON_REQUIRED");
    const previous = await this.db.read<{ id: string; revision: number } | undefined>({
      sql: `SELECT id, revision FROM doc_invoice_field_revision WHERE extraction_id = ? AND field_name = ? ORDER BY revision DESC LIMIT 1`,
      params: [extractionId, parsed.name], mode: "get",
    });
    const currentFields = await this.listInvoiceFields(extractionId);
    const normalized = new Map<string, unknown>();
    for (const current of currentFields) {
      try { normalized.set(String(current.field_name), JSON.parse(String(current.normalized_value_json)) as unknown); }
      catch { normalized.set(String(current.field_name), null); }
    }
    normalized.set(parsed.name, parsed.normalizedValue);
    const validationErrors = validateInvoiceFieldValues(Object.fromEntries(normalized));
    const status = validationErrors.length === 0 ? "VALIDATED" : "NEEDS_REVIEW";
    await this.db.write(command(actor, "INVOICE_FIELD_CORRECTED", "invoice_extraction", extractionId, [{
      sql: `INSERT INTO doc_invoice_field_revision(id, extraction_id, field_name, revision, previous_revision_id, raw_text,
            normalized_value_json, source_page, source_position_json, validation_errors_json, reason, actor_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [
        newId(), extractionId, parsed.name, (previous?.revision ?? 0) + 1, previous?.id ?? null, parsed.rawText,
        JSON.stringify(parsed.normalizedValue), parsed.page, JSON.stringify(parsed.position), JSON.stringify(parsed.validationErrors),
        normalizedReason, actor.userId, nowIso(),
      ],
    }, {
      sql: `UPDATE doc_invoice_extraction SET status = ?, validation_errors_json = ?, active_revision = active_revision + 1,
            updated_at = ? WHERE id = ?`, params: [status, JSON.stringify(validationErrors), nowIso(), extractionId], expectChanges: 1,
    }], { field: parsed.name, reasonLength: normalizedReason.length, status }));
  }
}
