import { z } from "zod";

export const EvidenceRevisionIdSchema = z.string().trim().min(1).max(128).brand<"EvidenceRevisionId">();
export type EvidenceRevisionId = z.infer<typeof EvidenceRevisionIdSchema>;

export const ExtractionKindSchema = z.enum(["BANK_CSV", "BANK_SPREADSHEET", "INVOICE_PDF"]);
export type ExtractionKind = z.infer<typeof ExtractionKindSchema>;

export interface ExtractionContext {
  readonly evidenceRevisionId: EvidenceRevisionId;
  readonly filePath: string;
  readonly contentSha256: string;
}

export interface StructuredExtractor<TConfig, TPreview, TResult> {
  readonly kind: ExtractionKind;
  preview(context: ExtractionContext, config: TConfig): Promise<TPreview>;
  extract(context: ExtractionContext, config: TConfig): Promise<TResult>;
}

export interface SpreadsheetCell {
  readonly value: string | number | boolean | null;
  readonly formula?: string;
}

export type SpreadsheetRow = readonly SpreadsheetCell[];

export interface SpreadsheetWorkbookAdapter {
  listSheets(filePath: string): Promise<readonly string[]>;
  readRows(
    filePath: string,
    sheetName: string,
    limits: { readonly maxRows: number },
  ): AsyncIterable<SpreadsheetRow>;
}

export interface PdfTextItem {
  readonly page: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfDocumentAdapter {
  pageCount(filePath: string): Promise<number>;
  textItems(filePath: string, maxPages: number): Promise<readonly PdfTextItem[]>;
}
