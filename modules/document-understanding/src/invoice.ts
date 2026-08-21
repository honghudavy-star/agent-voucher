import { z } from "zod";
import type { PdfTextItem } from "./contracts.js";

export const InvoiceFieldNameSchema = z.enum([
  "invoiceCode",
  "invoiceNumber",
  "issueDate",
  "buyerName",
  "buyerTaxId",
  "sellerName",
  "sellerTaxId",
  "netAmountCents",
  "taxAmountCents",
  "totalAmountCents",
  "currency",
]);
export type InvoiceFieldName = z.infer<typeof InvoiceFieldNameSchema>;

export const InvoiceFieldSchema = z.object({
  name: InvoiceFieldNameSchema,
  rawText: z.string(),
  normalizedValue: z.union([z.string(), z.number().int().safe()]).nullable(),
  page: z.number().int().positive(),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  }),
  ambiguous: z.boolean(),
  validationErrors: z.array(z.string()),
});
export type InvoiceField = Readonly<z.infer<typeof InvoiceFieldSchema>>;

export const InvoiceExtractionStatusSchema = z.enum([
  "VALIDATED",
  "NEEDS_REVIEW",
  "OCR_REQUIRED",
  "PARTIAL_TEXT",
  "UNSUPPORTED_LAYOUT",
  "PASSWORD_PROTECTED",
  "CORRUPT_PDF",
  "FAILED",
]);
export type InvoiceExtractionStatus = z.infer<typeof InvoiceExtractionStatusSchema>;

export const InvoiceExtractionResultSchema = z.object({
  parserVersion: z.string().min(1),
  status: InvoiceExtractionStatusSchema,
  fields: z.array(InvoiceFieldSchema),
  validationErrors: z.array(z.string()),
});
export type InvoiceExtractionResult = Readonly<z.infer<typeof InvoiceExtractionResultSchema>>;

export interface InvoiceAmountValidation {
  readonly valid: boolean;
  readonly expectedTotalCents: number;
  readonly actualTotalCents: number;
  readonly differenceCents: number;
}

export const REQUIRED_INVOICE_FIELD_NAMES = Object.freeze([
  "invoiceNumber", "issueDate", "buyerName", "buyerTaxId", "sellerName", "sellerTaxId",
  "netAmountCents", "taxAmountCents", "totalAmountCents", "currency",
] as const satisfies readonly InvoiceFieldName[]);

export function validateInvoiceAmounts(netAmountCents: number, taxAmountCents: number, totalAmountCents: number): InvoiceAmountValidation {
  for (const amount of [netAmountCents, taxAmountCents, totalAmountCents]) {
    if (!Number.isSafeInteger(amount)) throw new RangeError("Invoice amounts must be safe integer cents");
  }
  const expectedTotalCents = netAmountCents + taxAmountCents;
  if (!Number.isSafeInteger(expectedTotalCents)) throw new RangeError("Invoice amount total is out of range");
  return Object.freeze({
    valid: expectedTotalCents === totalAmountCents,
    expectedTotalCents,
    actualTotalCents: totalAmountCents,
    differenceCents: totalAmountCents - expectedTotalCents,
  });
}

export function validateInvoiceFieldValues(values: Readonly<Record<string, unknown>>): readonly string[] {
  const errors: string[] = [];
  const amounts = [values.netAmountCents, values.taxAmountCents, values.totalAmountCents];
  if (amounts.every((value) => typeof value === "number" && Number.isSafeInteger(value))) {
    if (!validateInvoiceAmounts(amounts[0] as number, amounts[1] as number, amounts[2] as number).valid) errors.push("INVOICE_TOTAL_MISMATCH");
  } else {
    errors.push("INVOICE_AMOUNT_FIELDS_INCOMPLETE");
  }
  const missing = REQUIRED_INVOICE_FIELD_NAMES.filter((name) => values[name] === undefined || values[name] === null || values[name] === "");
  if (missing.length > 0) errors.push(`INVOICE_REQUIRED_FIELDS_MISSING:${missing.join(",")}`);
  return Object.freeze(errors);
}

export interface DeterministicTextLine {
  readonly page: number;
  readonly text: string;
  readonly items: readonly PdfTextItem[];
}

/** Stable reading order independent of the PDF adapter's object iteration order. */
export function orderPdfText(items: readonly PdfTextItem[], lineTolerance = 2): readonly DeterministicTextLine[] {
  const sorted = [...items]
    .filter((item) => item.text.trim().length > 0)
    .sort((left, right) => left.page - right.page || right.y - left.y || left.x - right.x || left.text.localeCompare(right.text, "zh-CN"));
  const lines: Array<{ page: number; anchorY: number; items: PdfTextItem[] }> = [];
  for (const item of sorted) {
    const current = lines.at(-1);
    if (!current || current.page !== item.page || Math.abs(current.anchorY - item.y) > lineTolerance) {
      lines.push({ page: item.page, anchorY: item.y, items: [item] });
    } else {
      current.items.push(item);
      current.items.sort((left, right) => left.x - right.x || left.text.localeCompare(right.text, "zh-CN"));
    }
  }
  return Object.freeze(lines.map((line) => Object.freeze({
    page: line.page,
    text: line.items.map((item) => item.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
    items: Object.freeze(line.items),
  })));
}

export function normalizedInvoiceText(items: readonly PdfTextItem[]): string {
  return orderPdfText(items).map((line) => line.text).join("\n");
}

export function findInvoiceTextValue(
  items: readonly PdfTextItem[],
  pattern: RegExp,
  occurrence = 0,
): { readonly rawText: string; readonly value: string; readonly page: number; readonly position: InvoiceField["position"] } | null {
  if (pattern.global) throw new Error("Invoice extraction patterns must not use the global flag");
  if (!Number.isInteger(occurrence) || occurrence < 0) throw new RangeError("Invoice extraction occurrence must be a non-negative integer");
  let remaining = occurrence;
  for (const line of orderPdfText(items)) {
    const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of line.text.matchAll(matcher)) {
      const value = match.groups?.value ?? match[1];
      const first = line.items[0];
      if (value === undefined || !first) continue;
      if (remaining > 0) { remaining -= 1; continue; }
      const minX = Math.min(...line.items.map((item) => item.x));
      const minY = Math.min(...line.items.map((item) => item.y));
      const maxX = Math.max(...line.items.map((item) => item.x + item.width));
      const maxY = Math.max(...line.items.map((item) => item.y + item.height));
      return Object.freeze({
        rawText: line.text,
        value: value.trim(),
        page: line.page,
        position: Object.freeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }),
      });
    }
  }
  return null;
}
