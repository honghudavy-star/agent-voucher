import { z } from "zod";

export const BankTransactionDataSchema = z.object({
  transactionDate: z.string().min(1),
  amountCents: z.number().int().safe(),
  balanceCents: z.number().int().safe().nullable(),
  transactionId: z.string().optional(),
  currency: z.literal("CNY").default("CNY"),
  counterpartyName: z.string().optional(),
  counterpartyAccount: z.string().optional(),
  summary: z.string().optional(),
  accountTail: z.string().optional(),
});
export type BankTransactionData = z.infer<typeof BankTransactionDataSchema>;

export const BankRevisionOperationSchema = z.enum(["IMPORT", "CORRECTION", "SOFT_DELETE", "RESTORE"]);
export type BankRevisionOperation = z.infer<typeof BankRevisionOperationSchema>;

export const BankTransactionRevisionSchema = z.object({
  id: z.string().min(1),
  transactionId: z.string().min(1),
  revision: z.number().int().positive(),
  previousRevisionId: z.string().min(1).nullable(),
  operation: BankRevisionOperationSchema,
  data: BankTransactionDataSchema,
  deleted: z.boolean(),
  reason: z.string().trim().min(1).nullable(),
  actorId: z.string().min(1),
  createdAt: z.string().datetime(),
});
type ParsedBankTransactionRevision = z.infer<typeof BankTransactionRevisionSchema>;
export type BankTransactionRevision = Omit<Readonly<ParsedBankTransactionRevision>, "data"> & {
  readonly data: Readonly<BankTransactionData>;
};

export interface RevisionMetadata {
  readonly id: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly reason: string;
}

function freezeRevision(revision: ParsedBankTransactionRevision): BankTransactionRevision {
  Object.freeze(revision.data);
  return Object.freeze(revision);
}

export function correctBankTransaction(
  current: BankTransactionRevision,
  patch: Partial<BankTransactionData>,
  metadata: RevisionMetadata,
): BankTransactionRevision {
  if (current.deleted) throw new Error("DELETED_TRANSACTION_REQUIRES_RESTORE");
  const reason = metadata.reason.trim();
  if (reason.length === 0) throw new Error("CORRECTION_REASON_REQUIRED");
  return freezeRevision(BankTransactionRevisionSchema.parse({
    id: metadata.id,
    transactionId: current.transactionId,
    revision: current.revision + 1,
    previousRevisionId: current.id,
    operation: "CORRECTION",
    data: { ...current.data, ...patch },
    deleted: false,
    reason,
    actorId: metadata.actorId,
    createdAt: metadata.createdAt,
  }));
}

export function softDeleteBankTransaction(
  current: BankTransactionRevision,
  metadata: RevisionMetadata,
): BankTransactionRevision {
  if (current.deleted) throw new Error("TRANSACTION_ALREADY_DELETED");
  const reason = metadata.reason.trim();
  if (reason.length === 0) throw new Error("DELETE_REASON_REQUIRED");
  return freezeRevision(BankTransactionRevisionSchema.parse({
    ...current,
    id: metadata.id,
    revision: current.revision + 1,
    previousRevisionId: current.id,
    operation: "SOFT_DELETE",
    deleted: true,
    reason,
    actorId: metadata.actorId,
    createdAt: metadata.createdAt,
  }));
}

export function restoreBankTransaction(
  current: BankTransactionRevision,
  metadata: RevisionMetadata,
): BankTransactionRevision {
  if (!current.deleted) throw new Error("TRANSACTION_NOT_DELETED");
  const reason = metadata.reason.trim();
  if (reason.length === 0) throw new Error("RESTORE_REASON_REQUIRED");
  return freezeRevision(BankTransactionRevisionSchema.parse({
    ...current,
    id: metadata.id,
    revision: current.revision + 1,
    previousRevisionId: current.id,
    operation: "RESTORE",
    deleted: false,
    reason,
    actorId: metadata.actorId,
    createdAt: metadata.createdAt,
  }));
}
