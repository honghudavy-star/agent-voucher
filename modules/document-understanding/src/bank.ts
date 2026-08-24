import { z } from "zod";

const ColumnReferenceSchema = z.string().trim().min(1).max(160);

export const CsvEncodingSchema = z.enum(["UTF-8", "GB18030"]);
export type CsvEncoding = z.infer<typeof CsvEncodingSchema>;

export const CsvDialectSchema = z.object({
  encoding: CsvEncodingSchema,
  delimiter: z.enum([",", ";", "\t", "|"]),
  quote: z.literal('"').default('"'),
  hasBom: z.boolean().default(false),
});
export type CsvDialect = z.infer<typeof CsvDialectSchema>;

const SharedColumnMappingSchema = z.object({
  transactionDate: ColumnReferenceSchema,
  balance: ColumnReferenceSchema,
  transactionId: ColumnReferenceSchema.optional(),
  currency: ColumnReferenceSchema.optional(),
  counterpartyName: ColumnReferenceSchema.optional(),
  counterpartyAccount: ColumnReferenceSchema.optional(),
  summary: ColumnReferenceSchema.optional(),
  accountTail: ColumnReferenceSchema.optional(),
});

const SignedAmountMappingSchema = SharedColumnMappingSchema.extend({
  amountMode: z.literal("SIGNED"),
  amount: ColumnReferenceSchema,
});

const DebitCreditMappingSchema = SharedColumnMappingSchema.extend({
  amountMode: z.literal("DEBIT_CREDIT"),
  debitAmount: ColumnReferenceSchema,
  creditAmount: ColumnReferenceSchema,
});

export const BankColumnMappingSchema = z.discriminatedUnion("amountMode", [
  SignedAmountMappingSchema,
  DebitCreditMappingSchema,
]);
export type BankColumnMapping = z.infer<typeof BankColumnMappingSchema>;

export const BankMappingProfileSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  revision: z.number().int().positive(),
  sourceKind: z.enum(["CSV", "SPREADSHEET"]),
  sheetName: z.string().trim().min(1).max(160).optional(),
  headerRow: z.number().int().positive(),
  dataStartRow: z.number().int().positive(),
  order: z.enum(["ASCENDING", "DESCENDING"]),
  csv: CsvDialectSchema.optional(),
  columns: BankColumnMappingSchema,
}).superRefine((value, context) => {
  if (value.dataStartRow <= value.headerRow) {
    context.addIssue({ code: "custom", path: ["dataStartRow"], message: "数据起始行必须位于表头之后" });
  }
  if (value.sourceKind === "CSV" && value.csv === undefined) {
    context.addIssue({ code: "custom", path: ["csv"], message: "CSV 映射必须声明编码和分隔符" });
  }
  if (value.sourceKind === "SPREADSHEET" && value.sheetName === undefined) {
    context.addIssue({ code: "custom", path: ["sheetName"], message: "电子表格映射必须选择工作表" });
  }
});
export type BankMappingProfile = z.infer<typeof BankMappingProfileSchema>;

export type AmountParseResult =
  | { readonly ok: true; readonly cents: number; readonly normalized: string }
  | { readonly ok: false; readonly code: "EMPTY" | "FORMULA" | "INVALID_FORMAT" | "TOO_PRECISE" | "OUT_OF_RANGE" };

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export function parseAmountToCents(input: unknown): AmountParseResult {
  if (input === null || input === undefined || input === "") return { ok: false, code: "EMPTY" };
  if (typeof input === "object") return { ok: false, code: "FORMULA" };
  if (typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint") {
    return { ok: false, code: "INVALID_FORMAT" };
  }

  let source = String(input).trim();
  if (source.startsWith("=") || source.length === 0) return source.length === 0
    ? { ok: false, code: "EMPTY" }
    : { ok: false, code: "FORMULA" };

  let negative = false;
  if (source.startsWith("(") && source.endsWith(")")) {
    negative = true;
    source = source.slice(1, -1).trim();
  }
  source = source.replaceAll(",", "").replace(/^[¥￥]\s*/, "").trim();
  if (source.startsWith("+")) source = source.slice(1);
  else if (source.startsWith("-")) {
    negative = !negative;
    source = source.slice(1);
  }
  if (!/^\d+(?:\.\d+)?$/.test(source)) return { ok: false, code: "INVALID_FORMAT" };
  const [whole = "0", fraction = ""] = source.split(".");
  if (fraction.length > 2) return { ok: false, code: "TOO_PRECISE" };
  const cents = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))) * (negative ? -1n : 1n);
  if (cents > MAX_SAFE_CENTS || cents < -MAX_SAFE_CENTS) return { ok: false, code: "OUT_OF_RANGE" };
  const value = Number(cents);
  return { ok: true, cents: value, normalized: `${value < 0 ? "-" : ""}${whole}.${fraction.padEnd(2, "0")}` };
}

export interface BankBalanceRow {
  readonly sourceRow: number;
  readonly amountCents: number;
  readonly balanceCents: number | null;
}

export interface BalanceIssue {
  readonly sourceRow: number;
  readonly code: "MISSING_BALANCE" | "BALANCE_MISMATCH";
  readonly expectedBalanceCents: number | null;
  readonly actualBalanceCents: number | null;
  readonly affected: boolean;
}

export interface BalanceValidation {
  readonly valid: boolean;
  readonly firstErrorSourceRow: number | null;
  readonly issues: readonly BalanceIssue[];
  readonly affectedSourceRows: readonly number[];
}

export function validateSourceOrderBalances(
  rows: readonly BankBalanceRow[],
  order: "ASCENDING" | "DESCENDING",
): BalanceValidation {
  const issues: BalanceIssue[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.balanceCents === null) {
      issues.push({
        sourceRow: row.sourceRow,
        code: "MISSING_BALANCE",
        expectedBalanceCents: null,
        actualBalanceCents: null,
        affected: false,
      });
    }
  }
  for (let index = 1; index < rows.length; index += 1) {
    const prior = rows[index - 1];
    const current = rows[index];
    if (!prior || !current || prior.balanceCents === null || current.balanceCents === null) continue;
    if (order === "ASCENDING") {
      const expected = prior.balanceCents + current.amountCents;
      if (expected !== current.balanceCents) {
        issues.push({ sourceRow: current.sourceRow, code: "BALANCE_MISMATCH", expectedBalanceCents: expected, actualBalanceCents: current.balanceCents, affected: false });
      }
    } else {
      const expected = current.balanceCents + prior.amountCents;
      if (expected !== prior.balanceCents) {
        issues.push({ sourceRow: prior.sourceRow, code: "BALANCE_MISMATCH", expectedBalanceCents: expected, actualBalanceCents: prior.balanceCents, affected: false });
      }
    }
  }
  issues.sort((left, right) => left.sourceRow - right.sourceRow);
  const firstErrorSourceRow = issues[0]?.sourceRow ?? null;
  const affectedSourceRows = firstErrorSourceRow === null
    ? []
    : rows.filter((row) => row.sourceRow >= firstErrorSourceRow).map((row) => row.sourceRow);
  return {
    valid: issues.length === 0,
    firstErrorSourceRow,
    issues: issues.map((issue) => Object.freeze({ ...issue, affected: firstErrorSourceRow !== null && issue.sourceRow >= firstErrorSourceRow })),
    affectedSourceRows: Object.freeze(affectedSourceRows),
  };
}

export function validateBankRows(
  rows: readonly (BankBalanceRow & { readonly issues: readonly string[] })[],
  order: "ASCENDING" | "DESCENDING",
): BalanceValidation {
  const balance = validateSourceOrderBalances(rows, order);
  const issueRows = rows.filter((row) => row.issues.length > 0).map((row) => row.sourceRow);
  const firstIssue = issueRows.length > 0 ? Math.min(...issueRows) : null;
  const firstErrorSourceRow = [balance.firstErrorSourceRow, firstIssue]
    .filter((value): value is number => value !== null).sort((left, right) => left - right)[0] ?? null;
  return {
    ...balance, valid: balance.valid && issueRows.length === 0, firstErrorSourceRow,
    affectedSourceRows: firstErrorSourceRow === null ? [] : rows.filter((row) => row.sourceRow >= firstErrorSourceRow).map((row) => row.sourceRow),
  };
}

export interface PreviewRow<T> {
  readonly sourceRow: number;
  readonly value: T;
}

export interface BankPreview<T> {
  readonly first: readonly PreviewRow<T>[];
  readonly last: readonly PreviewRow<T>[];
  readonly errors: readonly PreviewRow<T>[];
}

export function buildBankPreview<T>(
  rows: readonly PreviewRow<T>[],
  errorSourceRows: ReadonlySet<number>,
  edgeSize = 20,
): BankPreview<T> {
  if (!Number.isInteger(edgeSize) || edgeSize < 0) throw new RangeError("edgeSize must be a non-negative integer");
  return {
    first: Object.freeze(rows.slice(0, edgeSize)),
    last: Object.freeze(rows.slice(Math.max(0, rows.length - edgeSize))),
    errors: Object.freeze(rows.filter((row) => errorSourceRows.has(row.sourceRow))),
  };
}

export const BankImportStatusSchema = z.enum(["VALIDATED", "NEEDS_REVIEW", "OVERRIDDEN_UNREVIEWED"]);
export type BankImportStatus = z.infer<typeof BankImportStatusSchema>;

export function decideBankImportStatus(
  validation: BalanceValidation,
  override?: { readonly roles: readonly string[]; readonly reason: string },
): BankImportStatus {
  if (validation.valid) return "VALIDATED";
  if (!override) return "NEEDS_REVIEW";
  if (!override.roles.some((role) => role === "ADMIN" || role === "OPERATOR")) return "NEEDS_REVIEW";
  return override.reason.trim().length > 0 ? "OVERRIDDEN_UNREVIEWED" : "NEEDS_REVIEW";
}
