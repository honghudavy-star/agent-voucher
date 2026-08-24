import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import DOMMatrixPolyfill from "@thednp/dommatrix";
import * as XLSX from "xlsx";
import {
  BankMappingProfileSchema,
  buildBankPreview,
  findInvoiceTextValue,
  orderPdfText,
  parseAmountToCents,
  parseCsvBytes,
  PARSER_LIMITS,
  validateBankRows,
  validateInvoiceFieldValues,
  type BankMappingProfile,
  type InvoiceField,
  type PdfTextItem,
  type SpreadsheetCell,
} from "@agent-voucher/document-understanding";
import { ParserRequestSchema, encodeParserMessage, type ParserResponse } from "@agent-voucher/document-understanding";

interface ParsedBankRow {
  sourceRow: number;
  transactionDate: string;
  amountCents: number;
  balanceCents: number | null;
  transactionId?: string;
  currency: "CNY";
  counterpartyName?: string;
  counterpartyAccount?: string;
  summary?: string;
  accountTail?: string;
  rawCells: Readonly<Record<string, string | number | boolean | null>>;
  issues: string[];
  possibleDuplicate: boolean;
}

if (!("DOMMatrix" in globalThis)) {
  Object.defineProperty(globalThis, "DOMMatrix", { value: DOMMatrixPolyfill, configurable: true, writable: true });
}

interface BankParserResult {
  parserVersion: "bank-structured-v1";
  headerSignature: string;
  rows: ParsedBankRow[];
  validation: ReturnType<typeof validateBankRows>;
  preview: ReturnType<typeof buildBankPreview<ParsedBankRow>>;
}

async function readLine(): Promise<string> {
  let value = "";
  for await (const chunk of stdin) {
    value += Buffer.from(chunk).toString("utf8");
    const newline = value.indexOf("\n");
    if (newline >= 0) return value.slice(0, newline);
  }
  return value;
}

function cellValue(cell: SpreadsheetCell | undefined): unknown {
  return cell?.formula ? { formula: cell.formula } : cell?.value;
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined || typeof value === "object") return undefined;
  if (!["string", "number", "bigint", "boolean"].includes(typeof value)) return undefined;
  const normalized = `${value as string | number | bigint | boolean}`.trim();
  return normalized || undefined;
}

function dateValue(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  const source = stringValue(value);
  if (!source) return undefined;
  const match = /(?<year>20\d{2})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})/.exec(source);
  const year = match?.groups?.year; const month = match?.groups?.month; const day = match?.groups?.day;
  if (!year || !month || !day) return undefined;
  const numericYear = Number(year); const numericMonth = Number(month); const numericDay = Number(day);
  const parsed = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));
  if (parsed.getUTCFullYear() !== numericYear || parsed.getUTCMonth() !== numericMonth - 1 || parsed.getUTCDate() !== numericDay) return undefined;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function sheetRows(filePath: string, sheetName: string, maxSourceRows: number): SpreadsheetCell[][] {
  const bytes = readFileSync(filePath); assertSafeSpreadsheetContainer(bytes);
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: true, cellFormula: true, bookVBA: true, dense: false, sheetRows: maxSourceRows + 1 });
  if (workbook.vbaraw) throw new Error("SPREADSHEET_MACRO_REJECTED");
  const sheetMetadata = workbook.Workbook?.Sheets?.find((item) => item.name === sheetName);
  if (sheetMetadata?.Hidden) throw new Error("SPREADSHEET_HIDDEN_SHEET_REJECTED");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"]) throw new Error("SPREADSHEET_SHEET_NOT_FOUND");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.r + 1 > maxSourceRows) throw new Error("BANK_ROW_LIMIT_EXCEEDED");
  if (range.e.c - range.s.c + 1 > 256) throw new Error("BANK_COLUMN_LIMIT_EXCEEDED");
  const rows: SpreadsheetCell[][] = Array.from({ length: range.s.r }, () => []);
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row: SpreadsheetCell[] = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] as { v?: unknown; f?: unknown } | undefined;
      const rawValue = cell?.v;
      const value = rawValue instanceof Date ? rawValue.toISOString()
        : typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean" ? rawValue : null;
      const formula = typeof cell?.f === "string" ? cell.f : undefined;
      row.push({ value, ...(formula ? { formula } : {}) });
    }
    rows.push(row);
  }
  return rows;
}

async function rowsForBank(filePath: string, profile: BankMappingProfile): Promise<SpreadsheetCell[][]> {
  const maxSourceRows = profile.dataStartRow - 1 + PARSER_LIMITS.maxBankRows;
  if (profile.sourceKind === "SPREADSHEET") return sheetRows(filePath, profile.sheetName ?? "", maxSourceRows);
  const bytes = await readFileAsync(filePath);
  const parsed = parseCsvBytes(bytes, profile.csv!, {
    decode: (value, encoding) => new TextDecoder(encoding === "GB18030" ? "gb18030" : "utf-8", { fatal: true }).decode(value),
  }, maxSourceRows);
  return parsed.rows.map((row) => row.map((value) => ({ value })));
}

function columnIndexes(headers: SpreadsheetCell[]): Map<string, number> {
  const result = new Map<string, number>();
  headers.forEach((cell, index) => {
    const name = stringValue(cellValue(cell));
    if (!name) return;
    if (result.has(name)) throw new Error(`DUPLICATE_HEADER:${name}`);
    result.set(name, index);
  });
  return result;
}

function mappedCell(row: SpreadsheetCell[], indexes: Map<string, number>, header: string): SpreadsheetCell | undefined {
  const index = indexes.get(header);
  if (index === undefined) throw new Error(`MAPPING_HEADER_NOT_FOUND:${header}`);
  return row[index];
}

async function parseBank(filePath: string, rawProfile: unknown): Promise<BankParserResult> {
  const profile = BankMappingProfileSchema.parse(rawProfile);
  const rows = await rowsForBank(filePath, profile);
  const header = rows[profile.headerRow - 1];
  if (!header) throw new Error("HEADER_ROW_NOT_FOUND");
  const indexes = columnIndexes(header);
  const headerSignature = createHash("sha256").update(JSON.stringify([...indexes.keys()])).digest("hex");
  const parsedRows: ParsedBankRow[] = [];
  for (let index = profile.dataStartRow - 1; index < rows.length; index += 1) {
    const source = rows[index];
    if (!source || source.every((cell) => stringValue(cellValue(cell)) === undefined)) continue;
    const issues: string[] = [];
    const transactionDate = dateValue(cellValue(mappedCell(source, indexes, profile.columns.transactionDate)));
    if (!transactionDate) issues.push("INVALID_TRANSACTION_DATE");
    let amount = { ok: false, code: "EMPTY" } as ReturnType<typeof parseAmountToCents>;
    if (profile.columns.amountMode === "SIGNED") {
      amount = parseAmountToCents(cellValue(mappedCell(source, indexes, profile.columns.amount)));
    } else {
      const debitRaw = cellValue(mappedCell(source, indexes, profile.columns.debitAmount));
      const creditRaw = cellValue(mappedCell(source, indexes, profile.columns.creditAmount));
      const debit = parseAmountToCents(debitRaw); const credit = parseAmountToCents(creditRaw);
      const debitCents = debit.ok ? debit.cents : 0; const creditCents = credit.ok ? credit.cents : 0;
      const debitChosen = debit.ok && debitCents > 0; const creditChosen = credit.ok && creditCents > 0;
      if (debitChosen === creditChosen) {
        issues.push(debitChosen ? "DEBIT_CREDIT_CONFLICT" : "DEBIT_CREDIT_AMOUNT_REQUIRED");
        amount = { ok: false, code: "INVALID_FORMAT" };
      } else if (debitChosen) {
        const creditEmpty = !credit.ok && credit.code === "EMPTY";
        if (!(creditEmpty || (credit.ok && creditCents === 0))) issues.push(`INVALID_CREDIT_AMOUNT:${credit.ok ? "NON_ZERO" : credit.code}`);
        amount = { ok: true, cents: -debitCents, normalized: String(-debitCents) };
      } else {
        const debitEmpty = !debit.ok && debit.code === "EMPTY";
        if (!(debitEmpty || (debit.ok && debitCents === 0))) issues.push(`INVALID_DEBIT_AMOUNT:${debit.ok ? "NON_ZERO" : debit.code}`);
        amount = { ok: true, cents: creditCents, normalized: String(creditCents) };
      }
    }
    if (!amount.ok) issues.push(`INVALID_AMOUNT:${amount.code}`);
    const balance = parseAmountToCents(cellValue(mappedCell(source, indexes, profile.columns.balance)));
    if (!balance.ok) issues.push(`INVALID_BALANCE:${balance.code}`);
    const currency = profile.columns.currency ? stringValue(cellValue(mappedCell(source, indexes, profile.columns.currency))) : "CNY";
    if (currency && !["CNY", "RMB", "人民币"].includes(currency.toUpperCase())) issues.push("UNSUPPORTED_CURRENCY");
    const rawCells = Object.fromEntries([...indexes.entries()].map(([name, column]) => [name, cellValue(source[column]) as string | number | boolean | null]));
    const optional = (headerName: string | undefined): string | undefined => headerName ? stringValue(cellValue(mappedCell(source, indexes, headerName))) : undefined;
    const transactionId = optional(profile.columns.transactionId);
    const counterpartyName = optional(profile.columns.counterpartyName);
    const counterpartyAccount = optional(profile.columns.counterpartyAccount);
    const summary = optional(profile.columns.summary);
    const accountTail = optional(profile.columns.accountTail);
    parsedRows.push({
      sourceRow: index + 1, transactionDate: transactionDate ?? "", amountCents: amount.ok ? amount.cents : 0,
      balanceCents: balance.ok ? balance.cents : null, currency: "CNY", rawCells, issues, possibleDuplicate: false,
      ...(transactionId ? { transactionId } : {}),
      ...(counterpartyName ? { counterpartyName } : {}),
      ...(counterpartyAccount ? { counterpartyAccount } : {}),
      ...(summary ? { summary } : {}),
      ...(accountTail ? { accountTail } : {}),
    });
    if (parsedRows.length > PARSER_LIMITS.maxBankRows) throw new Error("BANK_ROW_LIMIT_EXCEEDED");
  }
  const fingerprints = new Map<string, number>();
  for (const row of parsedRows) {
    const key = row.transactionId || `${row.transactionDate}|${String(row.amountCents)}|${row.counterpartyName ?? ""}|${row.summary ?? ""}`;
    const count = fingerprints.get(key) ?? 0; fingerprints.set(key, count + 1);
  }
  for (const row of parsedRows) {
    const key = row.transactionId || `${row.transactionDate}|${String(row.amountCents)}|${row.counterpartyName ?? ""}|${row.summary ?? ""}`;
    row.possibleDuplicate = (fingerprints.get(key) ?? 0) > 1;
  }
  const validation = validateBankRows(parsedRows, profile.order);
  const errorRows = new Set([
    ...parsedRows.filter((row) => row.issues.length > 0).map((row) => row.sourceRow),
    ...validation.affectedSourceRows,
  ]);
  return { parserVersion: "bank-structured-v1", headerSignature, rows: parsedRows, validation, preview: buildBankPreview(parsedRows.map((value) => ({ sourceRow: value.sourceRow, value })), errorRows) };
}

async function pdfTextItems(filePath: string): Promise<{ pageCount: number; items: PdfTextItem[] }> {
  const [pdfjs, pdfjsWorker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]);
  Object.defineProperty(globalThis, "pdfjsWorker", {
    value: { WorkerMessageHandler: pdfjsWorker.WorkerMessageHandler }, configurable: true, writable: true,
  });
  const bytes = new Uint8Array(await readFileAsync(filePath));
  const document = await pdfjs.getDocument({ data: bytes, stopAtErrors: true, useSystemFonts: false }).promise;
  if (document.numPages > 500) throw new Error("PDF_PAGE_LIMIT_EXCEEDED");
  const [actions, attachments] = await Promise.all([document.getJSActions(), document.getAttachments()]);
  if ((actions && Object.keys(actions).length > 0) || (attachments && Object.keys(attachments).length > 0)) throw new Error("PDF_ACTIVE_CONTENT_REJECTED");
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent() as { items: unknown[] };
    for (const rawItem of content.items) {
      if (!rawItem || typeof rawItem !== "object" || !("str" in rawItem) || !("transform" in rawItem)) continue;
      const item = rawItem as { str: unknown; transform: unknown; width?: unknown; height?: unknown };
      if (typeof item.str !== "string" || !Array.isArray(item.transform)) continue;
      items.push({
        page: pageNumber, text: item.str,
        x: typeof item.transform[4] === "number" ? item.transform[4] : 0,
        y: typeof item.transform[5] === "number" ? item.transform[5] : 0,
        width: typeof item.width === "number" ? item.width : 0, height: typeof item.height === "number" ? item.height : 0,
      });
    }
  }
  return { pageCount: document.numPages, items };
}

function assertSafeSpreadsheetContainer(bytes: Buffer): void {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return;
  const minimum = Math.max(0, bytes.length - 65_557); let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("SPREADSHEET_ZIP_DIRECTORY_MISSING");
  const entryCount = bytes.readUInt16LE(endOffset + 10); const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (entryCount > 10_000) throw new Error("SPREADSHEET_ENTRY_LIMIT_EXCEEDED");
  let offset = centralOffset; let totalUncompressed = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("SPREADSHEET_ZIP_DIRECTORY_CORRUPT");
    const compressed = bytes.readUInt32LE(offset + 20); const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28); const extraLength = bytes.readUInt16LE(offset + 30); const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("SPREADSHEET_ZIP_PATH_REJECTED");
    if (/vbaProject\.bin|^xl\/externalLinks\/|^xl\/embeddings\//i.test(name)) throw new Error("SPREADSHEET_ACTIVE_CONTENT_REJECTED");
    if (uncompressed > 50 * 1024 * 1024 || (compressed > 0 && uncompressed / compressed > 200)) throw new Error("SPREADSHEET_EXPANSION_LIMIT_EXCEEDED");
    totalUncompressed += uncompressed;
    if (totalUncompressed > 200 * 1024 * 1024) throw new Error("SPREADSHEET_EXPANSION_LIMIT_EXCEEDED");
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function invoiceField(items: readonly PdfTextItem[], name: InvoiceField["name"], pattern: RegExp, amount = false, occurrence = 0): InvoiceField | undefined {
  const found = findInvoiceTextValue(items, pattern, occurrence);
  if (!found) return undefined;
  const parsed = amount ? parseAmountToCents(found.value) : undefined;
  return {
    name, rawText: found.rawText, normalizedValue: amount ? (parsed?.ok ? parsed.cents : null) : found.value,
    page: found.page, position: found.position, ambiguous: false,
    validationErrors: amount && !parsed?.ok ? [`INVALID_AMOUNT:${parsed?.code ?? "UNKNOWN"}`] : [],
  };
}

async function parseInvoice(filePath: string): Promise<Record<string, unknown>> {
  let result: { pageCount: number; items: PdfTextItem[] };
  try { result = await pdfTextItems(filePath); }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : "PDF_FAILED";
    const status = /password/i.test(message) ? "PASSWORD_PROTECTED" : /invalid|corrupt/i.test(message) ? "CORRUPT_PDF" : "FAILED";
    return { parserVersion: "invoice-text-v1", status, fields: [], validationErrors: [message] };
  }
  const text = orderPdfText(result.items).map((line) => line.text).join("\n");
  if (text.trim().length < 20) return { parserVersion: "invoice-text-v1", status: "OCR_REQUIRED", fields: [], validationErrors: ["NO_USABLE_TEXT_LAYER"] };
  const fields: InvoiceField[] = [
    invoiceField(result.items, "invoiceCode", /发票代码\s*[:：]?\s*(?<value>[0-9]{10,20})/),
    invoiceField(result.items, "invoiceNumber", /发票号码\s*[:：]?\s*(?<value>[0-9]{8,30})/),
    invoiceField(result.items, "issueDate", /开票日期\s*[:：]?\s*(?<value>20\d{2}[-年/.]\d{1,2}[-月/.]\d{1,2}日?)/),
    invoiceField(result.items, "buyerName", /名\s*称\s*[:：]?\s*(?<value>.+?)(?=\s+(?:销\s*)?名\s*称|$)/u),
    invoiceField(result.items, "buyerTaxId", /(?:统一社会信用代码\s*\/\s*)?纳税人识别号\s*[:：]?\s*(?<value>[0-9A-Z]{15,20})/u),
    invoiceField(result.items, "sellerName", /名\s*称\s*[:：]?\s*(?<value>.+?)(?=\s+(?:销\s*)?名\s*称|$)/u, false, 1),
    invoiceField(result.items, "sellerTaxId", /(?:统一社会信用代码\s*\/\s*)?纳税人识别号\s*[:：]?\s*(?<value>[0-9A-Z]{15,20})/u, false, 1),
    invoiceField(result.items, "netAmountCents", /合\s*计[^\n]{0,40}?¥?￥?\s*(?<value>[0-9,]+\.\d{2})/, true),
    invoiceField(result.items, "taxAmountCents", /合\s*计[^\n]{0,80}?¥?￥?\s*[0-9,]+\.\d{2}\s+¥?￥?\s*(?<value>[0-9,]+\.\d{2})/, true),
    invoiceField(result.items, "totalAmountCents", /价税合计[^\n]{0,80}?[（(]小写[）)]\s*¥?￥?\s*(?<value>[0-9,]+\.\d{2})/, true),
  ].filter((field): field is InvoiceField => field !== undefined);
  const currencySource = fields.find((field) => field.name === "totalAmountCents" || field.name === "netAmountCents");
  if (currencySource) fields.push({
    name: "currency", rawText: currencySource.rawText, normalizedValue: "CNY", page: currencySource.page,
    position: currencySource.position, ambiguous: false, validationErrors: [],
  });
  const values = Object.fromEntries(fields.map((field) => [field.name, field.normalizedValue]));
  const validationErrors = validateInvoiceFieldValues(values);
  const invoiceSignals = fields.filter((field) => ["invoiceNumber", "issueDate", "totalAmountCents"].includes(field.name)).length;
  const status = invoiceSignals === 0 ? "UNSUPPORTED_LAYOUT" : validationErrors.length > 0 ? "PARTIAL_TEXT" : "VALIDATED";
  return { parserVersion: "invoice-text-v1", status, fields, validationErrors, pageCount: result.pageCount };
}

async function main(): Promise<void> {
  const line = await readLine();
  let response: ParserResponse;
  let requestId = "unknown";
  try {
    const request = ParserRequestSchema.parse(JSON.parse(line));
    requestId = request.requestId;
    const result = request.kind === "INVOICE_PDF" ? await parseInvoice(request.filePath) : await parseBank(request.filePath, request.config);
    response = { protocolVersion: 1, requestId: request.requestId, ok: true, result };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "PARSER_FAILED";
    const code = message.includes("ROW_LIMIT") ? "BANK_ROW_LIMIT_EXCEEDED"
      : message.includes("PAGE_LIMIT") ? "PDF_PAGE_LIMIT_EXCEEDED"
        : message.includes("PASSWORD") ? "PASSWORD_PROTECTED"
          : message.includes("CORRUPT") ? "CORRUPT_DOCUMENT" : "UNSUPPORTED_FORMAT";
    response = { protocolVersion: 1, requestId, ok: false, error: { code, message: message.slice(0, 500) } };
  }
  stdout.write(encodeParserMessage(response));
}

await main();
