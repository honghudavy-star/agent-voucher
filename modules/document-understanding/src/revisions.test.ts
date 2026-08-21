import { describe, expect, it } from "vitest";
import { BankTransactionRevisionSchema, correctBankTransaction, softDeleteBankTransaction } from "./revisions.js";

const imported = BankTransactionRevisionSchema.parse({
  id: "revision-1",
  transactionId: "transaction-1",
  revision: 1,
  previousRevisionId: null,
  operation: "IMPORT",
  data: { transactionDate: "2026-08-20", amountCents: 1250, balanceCents: 5000, currency: "CNY" },
  deleted: false,
  reason: null,
  actorId: "operator-1",
  createdAt: "2026-08-20T10:00:00.000Z",
});

describe("immutable bank revisions", () => {
  it("creates a correction without mutating the prior revision", () => {
    const corrected = correctBankTransaction(imported, { amountCents: 1350 }, {
      id: "revision-2",
      actorId: "operator-1",
      createdAt: "2026-08-20T10:01:00.000Z",
      reason: "source cell corrected",
    });
    expect(imported.data.amountCents).toBe(1250);
    expect(corrected.data.amountCents).toBe(1350);
    expect(corrected.previousRevisionId).toBe("revision-1");
    expect(corrected.revision).toBe(2);
    expect(Object.isFrozen(corrected)).toBe(true);
    expect(Object.isFrozen(corrected.data)).toBe(true);
  });

  it("soft deletes by appending a tombstone revision", () => {
    const deleted = softDeleteBankTransaction(imported, {
      id: "revision-2",
      actorId: "operator-1",
      createdAt: "2026-08-20T10:01:00.000Z",
      reason: "duplicate source row",
    });
    expect(deleted.deleted).toBe(true);
    expect(deleted.operation).toBe("SOFT_DELETE");
    expect(imported.deleted).toBe(false);
  });

  it("rejects corrections without a reason", () => {
    expect(() => correctBankTransaction(imported, {}, {
      id: "revision-2",
      actorId: "operator-1",
      createdAt: "2026-08-20T10:01:00.000Z",
      reason: "",
    })).toThrow("CORRECTION_REASON_REQUIRED");
  });
});
