import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DocumentUnderstandingService, EvidenceRevisionIdSchema } from "@agent-voucher/document-understanding";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

const rowCount = Number(process.env.AGENT_VOUCHER_PHASE2_ROWS ?? 100_000);
if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > 100_000) throw new Error("AGENT_VOUCHER_PHASE2_ROWS必须在1到100000之间");
const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-load-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb);
await db.start(); const actor: ActorSnapshot = { userId: "load-admin", username: "load-admin", roles: ["ADMIN"] };
const lines = ["日期,金额,余额,交易号,对方"];
for (let index = 1; index <= rowCount; index += 1) lines.push(`2026-08-01,0.01,${(index / 100).toFixed(2)},TX-${String(index).padStart(6, "0")},供应商${String(index % 100)}`);
const content = `${lines.join("\n")}\n`; const filePath = join(root, "bank-100k.csv"); await writeFile(filePath, content);
const documents = new DocumentUnderstandingService(db, { entryPath: resolve("dist/parser-worker.js") });
const profile = {
  id: "load-mapping", name: "100k负载映射", revision: 1, sourceKind: "CSV" as const, headerRow: 1, dataStartRow: 2,
  order: "ASCENDING" as const, csv: { encoding: "UTF-8" as const, delimiter: "," as const, quote: '"' as const, hasBom: false },
  columns: { amountMode: "SIGNED" as const, transactionDate: "日期", amount: "金额", balance: "余额", transactionId: "交易号", counterpartyName: "对方" },
};
const readLatencies: number[] = []; const errors: string[] = []; let reading = true;
const readers = Array.from({ length: 5 }, async () => {
  while (reading) {
    const started = performance.now();
    try { await db.read({ sql: "SELECT count(*) AS count FROM aud_event", mode: "get" }); }
    catch (error: unknown) { errors.push(error instanceof Error ? error.message : "read failed"); }
    finally { readLatencies.push(performance.now() - started); }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
});

try {
  const parseStarted = performance.now();
  const parsed = await documents.parseBank({
    evidenceRevisionId: EvidenceRevisionIdSchema.parse("phase2-load-evidence"), filePath,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  }, profile);
  const parseMs = performance.now() - parseStarted; const mappingRevision = await documents.saveMapping(actor, profile, parsed.headerSignature);
  const persistStarted = performance.now(); const importId = await documents.persistBankImport(actor, EvidenceRevisionIdSchema.parse("phase2-load-evidence"), mappingRevision, parsed);
  const persistMs = performance.now() - persistStarted; reading = false; await Promise.all(readers);
  const persisted = await documents.listBankTransactions(importId); const sorted = [...readLatencies].sort((left, right) => left - right);
  const readP95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? Infinity;
  const report = { rowCount, parsedRows: parsed.rows.length, persistedRows: persisted.length, parseMs, persistMs, readP95Ms, readErrors: errors.length };
  console.log(JSON.stringify(report, null, 2));
  if (!parsed.validation.valid || persisted.length !== rowCount || readP95Ms >= 500 || errors.length > 0) process.exitCode = 1;
} finally {
  reading = false; await Promise.allSettled(readers); await db.close(); await rm(root, { recursive: true, force: true });
}
