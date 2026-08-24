import { z } from "zod";
import { ExtractionKindSchema } from "./contracts.js";

export const PARSER_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  maxBankRows: 100_000,
  maxPdfPages: 500,
  timeoutMs: 60_000,
  maxOldSpaceMb: 256,
  maxResponseBytes: 64 * 1024 * 1024,
} as const);

export const ParserRequestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().min(1).max(128),
  kind: ExtractionKindSchema,
  filePath: z.string().min(1),
  fileSizeBytes: z.number().int().nonnegative().max(PARSER_LIMITS.maxFileBytes),
  config: z.record(z.string(), z.unknown()),
});
export type ParserRequest = z.infer<typeof ParserRequestSchema>;

export const ParserErrorCodeSchema = z.enum([
  "FILE_TOO_LARGE",
  "BANK_ROW_LIMIT_EXCEEDED",
  "PDF_PAGE_LIMIT_EXCEEDED",
  "PARSER_TIMEOUT",
  "PARSER_OOM",
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "PARSER_CRASHED",
  "PARSER_CANCELED",
  "UNSUPPORTED_FORMAT",
  "PASSWORD_PROTECTED",
  "CORRUPT_DOCUMENT",
]);
export type ParserErrorCode = z.infer<typeof ParserErrorCodeSchema>;

export const ParserResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    protocolVersion: z.literal(1),
    requestId: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    protocolVersion: z.literal(1),
    requestId: z.string().min(1),
    ok: z.literal(false),
    error: z.object({ code: ParserErrorCodeSchema, message: z.string().max(500) }),
  }),
]);
export type ParserResponse = z.infer<typeof ParserResponseSchema>;

export function encodeParserMessage(message: ParserRequest | ParserResponse): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeParserResponse(line: string): ParserResponse {
  return ParserResponseSchema.parse(JSON.parse(line));
}
