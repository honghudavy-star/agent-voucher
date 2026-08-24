import type { CsvDialect } from "./bank.js";

export interface CsvDecoderAdapter {
  decode(bytes: Uint8Array, encoding: CsvDialect["encoding"]): string;
}

export interface CsvParseResult {
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
}

/** Parses decoded RFC 4180-style data. Byte decoding stays injectable for GB18030 support. */
export function parseCsvText(text: string, dialect: Pick<CsvDialect, "delimiter" | "quote" | "hasBom">, maxRows = 100_000): CsvParseResult {
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new RangeError("maxRows must be a positive integer");
  const input = dialect.hasBom && text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const finishRow = (): void => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new Error("BANK_ROW_LIMIT_EXCEEDED");
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === dialect.quote) {
      if (quoted && input[index + 1] === dialect.quote) {
        field += dialect.quote;
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === dialect.delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      finishRow();
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error("CSV_UNTERMINATED_QUOTED_FIELD");
  if (field.length > 0 || row.length > 0) finishRow();
  return { rows: Object.freeze(rows.map((item) => Object.freeze(item))), rowCount: rows.length };
}

export function parseCsvBytes(
  bytes: Uint8Array,
  dialect: CsvDialect,
  decoder: CsvDecoderAdapter,
  maxRows = 100_000,
): CsvParseResult {
  return parseCsvText(decoder.decode(bytes, dialect.encoding), dialect, maxRows);
}
