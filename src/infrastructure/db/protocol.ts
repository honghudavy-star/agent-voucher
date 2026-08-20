import type { SqlStatement, WriteCommand } from "@agent-voucher/shared-kernel";

export type DbWorkerOperation =
  | { kind: "query"; statement: SqlStatement }
  | { kind: "write"; command: WriteCommand }
  | { kind: "health" }
  | { kind: "backup"; destination: string }
  | { kind: "close" };

export interface DbWorkerRequest {
  id: number;
  operation: DbWorkerOperation;
}

export interface DbWorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; code?: string };
}
