import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { DocumentUnderstandingService, EvidenceRevisionIdSchema } from "@agent-voucher/document-understanding";
import type { ActorSnapshot, CommandResult, DatabasePort, SqlStatement, WriteCommand } from "@agent-voucher/shared-kernel";
import { QueueFullError } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

function minimalTextPdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${String(Buffer.byteLength(stream))} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

describe("Phase 2 parser subprocess", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it("parses GB18030-capable CSV contracts and validates source-order balances outside the web process", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-voucher-parser-")); const paths = await prepareDataDir(root);
    const db = new DbClient(paths.appDb); await db.start();
    try {
      const file = join(root, "bank.csv"); const content = "日期,金额,余额,对方\n2026-08-01,100.00,100.00,甲方\n2026-08-02,-20.00,80.00,乙方\n"; await writeFile(file, content);
      const contentHash = createHash("sha256").update(content).digest("hex");
      const service = new DocumentUnderstandingService(db, {
        entryPath: resolve("dist/parser-worker.js"), resourceReadPaths: [resolve("node_modules")],
      });
      const result = await service.parseBank({ evidenceRevisionId: EvidenceRevisionIdSchema.parse("evd-rev"), filePath: file, contentSha256: contentHash }, {
        id: "mapping", name: "测试映射", revision: 1, sourceKind: "CSV", headerRow: 1, dataStartRow: 2, order: "ASCENDING",
        csv: { encoding: "UTF-8", delimiter: ",", quote: '"', hasBom: false },
        columns: { amountMode: "SIGNED", transactionDate: "日期", amount: "金额", balance: "余额", counterpartyName: "对方" },
      });
      expect(result.validation.valid).toBe(true); expect(result.rows).toHaveLength(2); expect(result.rows[1]).toMatchObject({ amountCents: -2000, balanceCents: 8000 });
      const actor: ActorSnapshot = { userId: "operator", username: "operator", roles: ["OPERATOR"] };
      const profile = {
        id: "mapping", name: "测试映射", revision: 1, sourceKind: "CSV" as const, headerRow: 1, dataStartRow: 2, order: "ASCENDING" as const,
        csv: { encoding: "UTF-8" as const, delimiter: "," as const, quote: '"' as const, hasBom: false },
        columns: { amountMode: "SIGNED" as const, transactionDate: "日期", amount: "金额", balance: "余额", counterpartyName: "对方" },
      };
      const mappingRevision = await service.saveMapping(actor, profile, result.headerSignature);
      const flaky: DatabasePort = {
        read: <T>(statement: SqlStatement) => db.read<T>(statement),
        write: (() => {
          let failed = false;
          return async (writeCommand: WriteCommand): Promise<CommandResult> => {
            if (!failed && writeCommand.commandType === "BANK_IMPORT_ROWS_STORED") { failed = true; throw new QueueFullError(); }
            return db.write(writeCommand);
          };
        })(),
      };
      const flakyService = new DocumentUnderstandingService(flaky, { entryPath: resolve("dist/parser-worker.js"), resourceReadPaths: [resolve("node_modules")] });
      await expect(flakyService.persistBankImport(actor, EvidenceRevisionIdSchema.parse("evd-rev"), mappingRevision, result)).rejects.toThrow(QueueFullError);
      const firstImport = await service.persistBankImport(actor, EvidenceRevisionIdSchema.parse("evd-rev"), mappingRevision, result);
      const replayImport = await service.persistBankImport(actor, EvidenceRevisionIdSchema.parse("evd-rev"), mappingRevision, result);
      expect(replayImport).toBe(firstImport); const persistedRows = await service.listBankTransactions(firstImport); expect(persistedRows).toHaveLength(2);
      await expect(service.reviseBankTransaction(actor, String(persistedRows[0]?.id), 1, {}, "无效修订")).rejects.toThrow();
      expect((await service.listBankTransactions(firstImport))[0]?.revision).toBe(1);

      const invalidFile = join(root, "bank-invalid.csv");
      const invalidContent = "日期,金额,余额\n2026-99-99,100.00,100.00\n2026-08-02,-20.00,80.00\n"; await writeFile(invalidFile, invalidContent);
      const invalid = await service.parseBank({ evidenceRevisionId: EvidenceRevisionIdSchema.parse("evd-invalid"), filePath: invalidFile, contentSha256: createHash("sha256").update(invalidContent).digest("hex") }, {
        ...profile, id: "invalid-mapping", columns: { amountMode: "SIGNED", transactionDate: "日期", amount: "金额", balance: "余额" },
      });
      expect(invalid.validation.valid).toBe(false); expect(invalid.validation.firstErrorSourceRow).toBe(2);
      const invalidMappingRevision = await service.saveMapping(actor, { ...profile, id: "invalid-mapping" }, invalid.headerSignature);
      const invalidImportId = await service.persistBankImport(actor, EvidenceRevisionIdSchema.parse("evd-invalid"), invalidMappingRevision, invalid);
      const invalidPersisted = (await service.listBankTransactions(invalidImportId))[0]!;
      const forged = { ...(JSON.parse(String(invalidPersisted.data_json)) as Record<string, unknown>), issues: [] };
      await expect(service.reviseBankTransaction(actor, String(invalidPersisted.id), 1, forged, "只清空问题字段")).rejects.toThrow(/calendar date/);
      expect((await service.listBankImports()).find((item) => item.id === invalidImportId)).toMatchObject({ status: "NEEDS_REVIEW" });
      const blankSidesFile = join(root, "bank-blank-sides.csv"); const blankSidesContent = "日期,支出,收入,余额\n2026-08-01,,,0.00\n";
      await writeFile(blankSidesFile, blankSidesContent);
      const blankSides = await service.parseBank({
        evidenceRevisionId: EvidenceRevisionIdSchema.parse("evd-blank"), filePath: blankSidesFile,
        contentSha256: createHash("sha256").update(blankSidesContent).digest("hex"),
      }, {
        ...profile, id: "blank-mapping",
        columns: { amountMode: "DEBIT_CREDIT", transactionDate: "日期", debitAmount: "支出", creditAmount: "收入", balance: "余额" },
      });
      expect(blankSides.validation.valid).toBe(false); expect(blankSides.rows[0]?.issues).toContain("DEBIT_CREDIT_AMOUNT_REQUIRED");

      const offsetWorkbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(offsetWorkbook, XLSX.utils.aoa_to_sheet([
        [], [], [], [], ["日期", "金额", "余额", "对方"], ["2026-08-01", "1.00", "1.00", "测试供应商"],
      ]), "流水");
      const offsetFile = join(root, "bank-offset.xlsx"); const offsetBytes = XLSX.write(offsetWorkbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
      await writeFile(offsetFile, offsetBytes);
      const offsetResult = await service.parseBank({
        evidenceRevisionId: EvidenceRevisionIdSchema.parse("evd-offset"), filePath: offsetFile,
        contentSha256: createHash("sha256").update(offsetBytes).digest("hex"),
      }, {
        ...profile, id: "offset-mapping", sourceKind: "SPREADSHEET", sheetName: "流水", headerRow: 5, dataStartRow: 6, csv: undefined,
      });
      expect(offsetResult.rows).toHaveLength(1); expect(offsetResult.rows[0]).toMatchObject({ sourceRow: 6, amountCents: 100, balanceCents: 100 });

      const formulaWorkbook = XLSX.utils.book_new();
      const formulaSheet = XLSX.utils.aoa_to_sheet([
        ["日期", "金额", "余额"], ["2026-08-01", "1.00", null], ["2026-08-02", null, "2.00"],
      ]);
      formulaSheet.C2 = { t: "n", f: "B2", v: 1 };
      formulaSheet.B3 = { t: "n", f: "B2", v: 1 };
      XLSX.utils.book_append_sheet(formulaWorkbook, formulaSheet, "公式流水");
      const formulaFile = join(root, "bank-formula.xlsx");
      const formulaBytes = XLSX.write(formulaWorkbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
      await writeFile(formulaFile, formulaBytes);
      const formulaProfile = {
        ...profile, id: "formula-mapping", sourceKind: "SPREADSHEET" as const, sheetName: "公式流水", csv: undefined,
        columns: { amountMode: "SIGNED" as const, transactionDate: "日期", amount: "金额", balance: "余额" },
      };
      const formulaResult = await service.parseBank({
        evidenceRevisionId: EvidenceRevisionIdSchema.parse("evd-formula"), filePath: formulaFile,
        contentSha256: createHash("sha256").update(formulaBytes).digest("hex"),
      }, formulaProfile);
      expect(formulaResult.validation.valid).toBe(false);
      const formulaRow = formulaResult.rows[0]!;
      expect(formulaRow.balanceCents).toBeNull();
      expect(formulaRow.issues).toContain("INVALID_BALANCE:FORMULA");
      expect(formulaRow.rawCells["余额"]).toEqual({ formula: "B2" });
      expect(formulaResult.rows[1]?.issues).toContain("INVALID_AMOUNT:FORMULA");
      expect(formulaResult.rows[1]?.rawCells["金额"]).toEqual({ formula: "B2" });
      const formulaMappingRevision = await service.saveMapping(actor, formulaProfile, formulaResult.headerSignature);
      const formulaImportId = await service.persistBankImport(
        actor, EvidenceRevisionIdSchema.parse("evd-formula"), formulaMappingRevision, formulaResult,
      );
      const persistedFormulaRows = await service.listBankTransactions(formulaImportId);
      const persistedBalanceFormula = JSON.parse(String(persistedFormulaRows[0]?.data_json)) as { rawCells: Record<string, unknown> };
      const persistedAmountFormula = JSON.parse(String(persistedFormulaRows[1]?.data_json)) as { rawCells: Record<string, unknown> };
      expect(persistedBalanceFormula.rawCells["余额"]).toEqual({ formula: "B2" });
      expect(persistedAmountFormula.rawCells["金额"]).toEqual({ formula: "B2" });

      const baseField = { rawText: "fixture", page: 1, position: { x: 0, y: 0, width: 1, height: 1 }, ambiguous: false, validationErrors: [] };
      const invoiceId = await service.persistInvoiceExtraction(actor, EvidenceRevisionIdSchema.parse("invoice-rev"), {
        parserVersion: "invoice-text-v1", status: "VALIDATED", validationErrors: [], fields: [
          { ...baseField, name: "invoiceNumber", normalizedValue: "12345678" },
          { ...baseField, name: "issueDate", normalizedValue: "2026-08-20" },
          { ...baseField, name: "buyerName", normalizedValue: "购买方" }, { ...baseField, name: "buyerTaxId", normalizedValue: "123456789012345" },
          { ...baseField, name: "sellerName", normalizedValue: "销售方" }, { ...baseField, name: "sellerTaxId", normalizedValue: "987654321098765" },
          { ...baseField, name: "netAmountCents", normalizedValue: 10_000 }, { ...baseField, name: "taxAmountCents", normalizedValue: 600 },
          { ...baseField, name: "totalAmountCents", normalizedValue: 10_600 }, { ...baseField, name: "currency", normalizedValue: "CNY" },
        ],
      });
      await service.correctInvoiceField(actor, invoiceId, { ...baseField, name: "totalAmountCents", normalizedValue: 999 }, "人工修正");
      expect((await service.listInvoiceExtractions()).find((item) => item.id === invoiceId)).toMatchObject({ status: "NEEDS_REVIEW", active_revision: 2 });

      const partialInvoiceId = await service.persistInvoiceExtraction(actor, EvidenceRevisionIdSchema.parse("partial-invoice-rev"), {
        parserVersion: "invoice-text-v1", status: "PARTIAL_TEXT", validationErrors: ["INVOICE_REQUIRED_FIELDS_MISSING"], fields: [
          { ...baseField, name: "netAmountCents", normalizedValue: 10_000 },
          { ...baseField, name: "taxAmountCents", normalizedValue: 600 },
          { ...baseField, name: "totalAmountCents", normalizedValue: 10_600 },
        ],
      });
      const additions = [
        ["invoiceNumber", "12345678"], ["issueDate", "2026-08-20"], ["buyerName", "购买方"],
        ["buyerTaxId", "123456789012345"], ["sellerName", "销售方"], ["sellerTaxId", "987654321098765"],
      ] as const;
      for (const [name, normalizedValue] of additions) {
        await service.correctInvoiceField(actor, partialInvoiceId, { ...baseField, name, normalizedValue }, `补录 ${name}`);
      }
      expect((await service.listInvoiceExtractions()).find((item) => item.id === partialInvoiceId)).toMatchObject({ status: "NEEDS_REVIEW" });
      await service.correctInvoiceField(actor, partialInvoiceId, { ...baseField, name: "currency", normalizedValue: "CNY" }, "补录 currency");
      expect((await service.listInvoiceExtractions()).find((item) => item.id === partialInvoiceId)).toMatchObject({ status: "VALIDATED" });
    } finally { await db.close(); }
  });

  it("loads a text-layer PDF without native canvas or an external PDF worker file", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-voucher-pdf-parser-")); const paths = await prepareDataDir(root);
    const db = new DbClient(paths.appDb); await db.start();
    try {
      const file = join(root, "text-layer.pdf"); const content = minimalTextPdf("Text layer invoice fixture with enough searchable content");
      await writeFile(file, content);
      const service = new DocumentUnderstandingService(db, { entryPath: resolve("dist/parser-worker.js") });
      const result = await service.parseInvoice({
        evidenceRevisionId: EvidenceRevisionIdSchema.parse("pdf-text-layer"), filePath: file,
        contentSha256: createHash("sha256").update(content).digest("hex"),
      });
      expect(result.status).toBe("UNSUPPORTED_LAYOUT");
      expect(result.validationErrors.join(" ")).not.toMatch(/DOMMatrix|fake worker|pdf\.worker/i);
    } finally { await db.close(); }
  });
});
