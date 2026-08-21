import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parserProcessArgs, runParserSubprocess, sanitizedParserEnvironment } from "./parser-launcher.js";
import type { ParserSpawnFactory } from "./parser-launcher.js";

class HangingChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { end: (): void => undefined };
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("parser subprocess launcher", () => {
  it("drops business secrets and applies all hard resource flags", () => {
    expect(sanitizedParserEnvironment({ PATH: "/bin", FEISHU_APP_SECRET: "secret", DATABASE_URL: "private" })).toEqual({
      NODE_ENV: "production",
      NO_COLOR: "1",
      PATH: "/bin",
    });
    const args = parserProcessArgs({
      protocolVersion: 1,
      requestId: "request-1",
      kind: "BANK_CSV",
      filePath: "/tmp/bank.csv",
      fileSizeBytes: 100,
      config: {},
    }, { entryPath: "/app/parser-child.js", resourceReadPaths: ["/app/parser-assets"] });
    expect(args).toContain("--max-old-space-size=256");
    expect(args).toContain("--permission");
    expect(args).toContain("--allow-fs-read=/tmp/bank.csv");
    expect(args).toContain("--allow-fs-read=/app/parser-assets");
  });

  it("kills a parser that exceeds its deadline", async () => {
    const child = new HangingChild();
    const spawnFactory: ParserSpawnFactory = () => child;
    const operation = runParserSubprocess({
      protocolVersion: 1,
      requestId: "request-1",
      kind: "INVOICE_PDF",
      filePath: "/tmp/invoice.pdf",
      fileSizeBytes: 100,
      config: {},
    }, {
      entryPath: "/tmp/parser-child.js",
      timeoutMs: 10,
      spawnFactory,
    });

    await expect(operation).rejects.toMatchObject({ code: "PARSER_TIMEOUT" });
    expect(child.killed).toBe(true);
  });
});
