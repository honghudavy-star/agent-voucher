import { randomUUID } from "node:crypto";
import { z } from "zod";

export const RoleSchema = z.enum(["ADMIN", "OPERATOR", "REVIEWER"]);
export type Role = z.infer<typeof RoleSchema>;

export const ActorSnapshotSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1),
  roles: z.array(RoleSchema),
  ipAddress: z.string().max(64).optional(),
});
export type ActorSnapshot = z.infer<typeof ActorSnapshotSchema>;

export interface SqlStatement {
  sql: string;
  params?: readonly SqlValue[];
  mode?: "run" | "get" | "all";
  expectChanges?: number;
}

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface AuditInput {
  action: string;
  objectType: string;
  objectId: string;
  beforeRevision?: number | null;
  afterRevision?: number | null;
  result: "SUCCESS" | "REJECTED" | "FAILED";
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WriteCommand {
  commandId: string;
  commandType: string;
  commandVersion: 1;
  correlationId: string;
  actor: ActorSnapshot;
  expectedRevision?: number;
  idempotencyKey?: string;
  requestHash?: string;
  statements: readonly SqlStatement[];
  audit: AuditInput;
}

export interface CommandResult {
  commandId: string;
  replayed: boolean;
  rows: unknown[];
}

export interface DatabasePort {
  read<T>(statement: SqlStatement): Promise<T>;
  write(command: WriteCommand): Promise<CommandResult>;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message = "数据已被其他用户修改，请刷新后重试") {
    super(message);
    this.name = "ConflictError";
  }
}

export class AuthorizationError extends Error {
  readonly statusCode = 403;
  constructor(message = "无权执行此操作") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class QueueFullError extends Error {
  readonly statusCode = 503;
  constructor(message = "写入队列已满，请稍后重试") {
    super(message);
    this.name = "QueueFullError";
  }
}

export function requireRole(actor: ActorSnapshot, ...roles: Role[]): void {
  if (!roles.some((role) => actor.roles.includes(role))) throw new AuthorizationError();
}

export function escapeHtml(value: unknown): string {
  const text = value == null ? "" : typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
