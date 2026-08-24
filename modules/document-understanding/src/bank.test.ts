import { describe, expect, it } from "vitest";
import {
  BankMappingProfileSchema,
  buildBankPreview,
  decideBankImportStatus,
  parseAmountToCents,
  validateSourceOrderBalances,
} from "./bank.js";

describe("bank mapping and integer amounts", () => {
  it("requires source-specific mapping settings", () => {
    const result = BankMappingProfileSchema.safeParse({
      id: "profile-1",
      name: "Bank CSV",
      revision: 1,
      sourceKind: "CSV",
      headerRow: 2,
      dataStartRow: 3,
      order: "ASCENDING",
      columns: { amountMode: "SIGNED", transactionDate: "交易日", amount: "金额", balance: "余额" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "csv")).toBe(true);
  });

  it("parses decimal amounts without floating point and rejects formulas", () => {
    expect(parseAmountToCents("￥1,234.5")).toEqual({ ok: true, cents: 123450, normalized: "1234.50" });
    expect(parseAmountToCents("(3.20)")).toEqual({ ok: true, cents: -320, normalized: "-3.20" });
    expect(parseAmountToCents("0.001")).toEqual({ ok: false, code: "TOO_PRECISE" });
    expect(parseAmountToCents("=SUM(A1:A2)")).toEqual({ ok: false, code: "FORMULA" });
  });
});

describe("source-order balance validation", () => {
  it("validates ascending source order", () => {
    const result = validateSourceOrderBalances([
      { sourceRow: 2, amountCents: 0, balanceCents: 100_00 },
      { sourceRow: 3, amountCents: 50_00, balanceCents: 150_00 },
      { sourceRow: 4, amountCents: -20_00, balanceCents: 130_00 },
    ], "ASCENDING");
    expect(result.valid).toBe(true);
  });

  it("validates descending source order and marks rows from the first mismatch", () => {
    const valid = validateSourceOrderBalances([
      { sourceRow: 2, amountCents: 50_00, balanceCents: 150_00 },
      { sourceRow: 3, amountCents: -20_00, balanceCents: 100_00 },
      { sourceRow: 4, amountCents: 10_00, balanceCents: 120_00 },
    ], "DESCENDING");
    expect(valid.valid).toBe(true);

    const invalid = validateSourceOrderBalances([
      { sourceRow: 2, amountCents: 50_00, balanceCents: 149_00 },
      { sourceRow: 3, amountCents: -20_00, balanceCents: 100_00 },
      { sourceRow: 4, amountCents: 10_00, balanceCents: 120_00 },
    ], "DESCENDING");
    expect(invalid.firstErrorSourceRow).toBe(2);
    expect(invalid.affectedSourceRows).toEqual([2, 3, 4]);
  });

  it("keeps all error samples while bounding preview edges", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ sourceRow: index + 1, value: `row-${index + 1}` }));
    const preview = buildBankPreview(rows, new Set([2, 25, 49]), 3);
    expect(preview.first.map((row) => row.sourceRow)).toEqual([1, 2, 3]);
    expect(preview.last.map((row) => row.sourceRow)).toEqual([48, 49, 50]);
    expect(preview.errors.map((row) => row.sourceRow)).toEqual([2, 25, 49]);
  });

  it("requires an authorized actor and reason for an override", () => {
    const invalid = validateSourceOrderBalances([
      { sourceRow: 2, amountCents: 0, balanceCents: 100 },
      { sourceRow: 3, amountCents: 10, balanceCents: 999 },
    ], "ASCENDING");
    expect(decideBankImportStatus(invalid)).toBe("NEEDS_REVIEW");
    expect(decideBankImportStatus(invalid, { roles: ["REVIEWER"], reason: "accepted" })).toBe("NEEDS_REVIEW");
    expect(decideBankImportStatus(invalid, { roles: ["OPERATOR"], reason: "  " })).toBe("NEEDS_REVIEW");
    expect(decideBankImportStatus(invalid, { roles: ["ADMIN"], reason: "source statement confirmed" })).toBe("OVERRIDDEN_UNREVIEWED");
  });
});
