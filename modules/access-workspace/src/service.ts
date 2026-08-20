import { createHash } from "node:crypto";
import type { ActorSnapshot, DatabasePort, Role, WriteCommand } from "@agent-voucher/shared-kernel";
import { newId, nowIso, requireRole } from "@agent-voucher/shared-kernel";
import { hashPassword, hashToken, newSecretToken, verifyPassword } from "./password.js";
import type { BootstrapInput, CreateUserInput, LoginInput, MasterDataInput, PeriodInput, UpdatePeriodInput, UpdateWorkspaceInput } from "./schemas.js";

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  status: "ACTIVE" | "DISABLED";
  failed_attempts: number;
  locked_until: string | null;
  revision: number;
  roles: string | null;
}

export interface AuthenticatedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  actor: ActorSnapshot;
}

export interface SessionContext {
  sessionId: string;
  csrfHash: string;
  actor: ActorSnapshot;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

const SYSTEM_ACTOR: ActorSnapshot = { userId: "SYSTEM", username: "system", roles: ["ADMIN"] };
let dummyHashPromise: Promise<string> | undefined;

function command(
  actor: ActorSnapshot,
  commandType: string,
  objectType: string,
  objectId: string,
  statements: WriteCommand["statements"],
  revisions: { before?: number | null; after?: number | null } = {},
  idempotencyKey?: string,
  requestHash?: string,
  auditResult: "SUCCESS" | "REJECTED" | "FAILED" = "SUCCESS",
): WriteCommand {
  return {
    commandId: newId(), commandType, commandVersion: 1, correlationId: newId(), actor,
    ...(idempotencyKey ? { idempotencyKey } : {}), ...(requestHash ? { requestHash } : {}), statements,
    audit: {
      action: commandType, objectType, objectId,
      beforeRevision: revisions.before ?? null, afterRevision: revisions.after ?? null,
      result: auditResult,
    },
  };
}

const stableHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class AccessWorkspaceService {
  constructor(private readonly db: DatabasePort) {}

  async isSetup(): Promise<boolean> {
    const row = await this.db.read<{ count: number } | undefined>({ sql: "SELECT count(*) AS count FROM iam_user", mode: "get" });
    return (row?.count ?? 0) > 0;
  }

  async bootstrap(input: BootstrapInput): Promise<void> {
    if (await this.isSetup()) throw new Error("系统已经完成初始化");
    const userId = newId();
    const createdAt = nowIso();
    const passwordHash = await hashPassword(input.password);
    await this.db.write(command(SYSTEM_ACTOR, "SYSTEM_BOOTSTRAP", "workspace", "default", [
      { sql: "INSERT INTO cfg_workspace(id, display_name, accounting_standard, currency, revision, created_at, updated_at) VALUES ('default', ?, 'CAS', 'CNY', 1, ?, ?)", params: [input.workspaceName, createdAt, createdAt] },
      { sql: "INSERT INTO cfg_ledger(id, workspace_id, name, revision, created_at, updated_at) VALUES ('default', 'default', ?, 1, ?, ?)", params: [input.ledgerName, createdAt, createdAt] },
      { sql: "INSERT INTO iam_user(id, username, display_name, password_hash, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?)", params: [userId, input.username, input.displayName, passwordHash, createdAt, createdAt] },
      { sql: "INSERT INTO iam_user_role(user_id, role) VALUES (?, 'ADMIN')", params: [userId] },
    ], { after: 1 }, "system-bootstrap", stableHash({ ...input, password: stableHash(input.password) })));
  }

  private async findUser(username: string): Promise<UserRow | undefined> {
    return this.db.read<UserRow | undefined>({
      sql: `SELECT u.*, group_concat(r.role) AS roles FROM iam_user u
            LEFT JOIN iam_user_role r ON r.user_id = u.id
            WHERE u.username = ? GROUP BY u.id`,
      params: [username], mode: "get",
    });
  }

  async authenticate(input: LoginInput, ipAddress?: string): Promise<AuthenticatedSession> {
    const user = await this.findUser(input.username);
    dummyHashPromise ??= hashPassword("Agent-Voucher-Dummy-Password-Only!");
    const passwordHash = user?.password_hash ?? await dummyHashPromise;
    const valid = await verifyPassword(input.password, passwordHash);
    const locked = user?.locked_until ? new Date(user.locked_until).getTime() > Date.now() : false;
    if (!user || !valid || locked || user.status !== "ACTIVE") {
      if (user) {
        const attempts = user.failed_attempts + 1;
        const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : user.locked_until;
        await this.db.write(command(SYSTEM_ACTOR, "LOGIN_REJECTED", "user", user.id, [{
          sql: "UPDATE iam_user SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?",
          params: [attempts, lockedUntil, nowIso(), user.id], expectChanges: 1,
        }], { before: user.revision, after: user.revision }, undefined, undefined, "REJECTED"));
      } else {
        await this.db.write(command(SYSTEM_ACTOR, "LOGIN_REJECTED", "user", "unknown", [], {}, undefined, undefined, "REJECTED"));
      }
      throw new Error("用户名或密码错误");
    }

    const token = newSecretToken();
    const csrfToken = newSecretToken();
    const sessionId = newId();
    const createdAt = nowIso();
    const actor: ActorSnapshot = {
      userId: user.id, username: user.username,
      roles: (user.roles?.split(",") ?? []) as Role[], ...(ipAddress ? { ipAddress } : {}),
    };
    await this.db.write(command(actor, "USER_LOGIN", "session", sessionId, [
      { sql: "UPDATE iam_user SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?", params: [createdAt, user.id], expectChanges: 1 },
      { sql: `INSERT INTO iam_session(id, user_id, token_hash, csrf_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, params: [
        sessionId, user.id, hashToken(token), hashToken(csrfToken), createdAt, createdAt,
        new Date(Date.now() + 30 * 60_000).toISOString(), new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      ] },
    ], { after: 1 }));
    return { sessionId, token, csrfToken, actor };
  }

  async getSession(token: string, ipAddress?: string): Promise<SessionContext | undefined> {
    const row = await this.db.read<(UserRow & {
      session_id: string; csrf_hash: string; last_seen_at: string; idle_expires_at: string; absolute_expires_at: string; revoked_at: string | null;
    }) | undefined>({
      sql: `SELECT u.*, group_concat(r.role) AS roles, s.id AS session_id, s.csrf_hash, s.last_seen_at,
                   s.idle_expires_at, s.absolute_expires_at, s.revoked_at
            FROM iam_session s JOIN iam_user u ON u.id = s.user_id
            LEFT JOIN iam_user_role r ON r.user_id = u.id
            WHERE s.token_hash = ? GROUP BY s.id`,
      params: [hashToken(token)], mode: "get",
    });
    if (!row || row.revoked_at || row.status !== "ACTIVE") return undefined;
    if (new Date(row.idle_expires_at).getTime() <= Date.now() || new Date(row.absolute_expires_at).getTime() <= Date.now()) return undefined;
    let idleExpiresAt = row.idle_expires_at;
    if (Date.now() - new Date(row.last_seen_at).getTime() >= 5 * 60_000) {
      const touchedAt = nowIso();
      idleExpiresAt = new Date(Math.min(Date.now() + 30 * 60_000, new Date(row.absolute_expires_at).getTime())).toISOString();
      const touchActor: ActorSnapshot = {
        userId: row.id, username: row.username, roles: (row.roles?.split(",") ?? []) as Role[], ...(ipAddress ? { ipAddress } : {}),
      };
      await this.db.write(command(touchActor, "SESSION_TOUCHED", "session", row.session_id, [{
        sql: "UPDATE iam_session SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND revoked_at IS NULL",
        params: [touchedAt, idleExpiresAt, row.session_id], expectChanges: 1,
      }]));
    }
    return {
      sessionId: row.session_id, csrfHash: row.csrf_hash,
      idleExpiresAt, absoluteExpiresAt: row.absolute_expires_at,
      actor: { userId: row.id, username: row.username, roles: (row.roles?.split(",") ?? []) as Role[], ...(ipAddress ? { ipAddress } : {}) },
    };
  }

  verifyCsrf(session: SessionContext, token: string): boolean {
    return hashToken(token) === session.csrfHash;
  }

  async revokeSession(actor: ActorSnapshot, sessionId: string): Promise<void> {
    await this.db.write(command(actor, "SESSION_REVOKED", "session", sessionId, [{
      sql: "UPDATE iam_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", params: [nowIso(), sessionId],
    }]));
  }

  async getWorkspace(): Promise<Record<string, unknown> | undefined> {
    return this.db.read({
      sql: `SELECT w.display_name, w.accounting_standard, w.currency, w.revision,
                   l.name AS ledger_name FROM cfg_workspace w JOIN cfg_ledger l ON l.workspace_id = w.id
            WHERE w.id = 'default'`, mode: "get",
    });
  }

  async updateWorkspace(actor: ActorSnapshot, input: UpdateWorkspaceInput): Promise<void> {
    requireRole(actor, "ADMIN");
    await this.db.write(command(actor, "WORKSPACE_UPDATED", "workspace", "default", [
      { sql: "UPDATE cfg_workspace SET display_name = ?, revision = revision + 1, updated_at = ? WHERE id = 'default' AND revision = ?", params: [input.displayName, nowIso(), input.revision], expectChanges: 1 },
      { sql: "UPDATE cfg_ledger SET name = ?, revision = revision + 1, updated_at = ? WHERE id = 'default'", params: [input.ledgerName, nowIso()], expectChanges: 1 },
    ], { before: input.revision, after: input.revision + 1 }));
  }

  async listUsers(): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: `SELECT u.id, u.username, u.display_name, u.status, u.revision,
      group_concat(r.role) AS roles, u.created_at FROM iam_user u LEFT JOIN iam_user_role r ON r.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at`, mode: "all" });
  }

  async createUser(actor: ActorSnapshot, input: CreateUserInput): Promise<void> {
    requireRole(actor, "ADMIN");
    const id = newId(); const timestamp = nowIso(); const passwordHash = await hashPassword(input.password);
    await this.db.write(command(actor, "USER_CREATED", "user", id, [
      { sql: "INSERT INTO iam_user(id, username, display_name, password_hash, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?)", params: [id, input.username, input.displayName, passwordHash, timestamp, timestamp] },
      ...input.roles.map((role) => ({ sql: "INSERT INTO iam_user_role(user_id, role) VALUES (?, ?)", params: [id, role] })),
    ], { after: 1 }, `create-user:${input.username.toLowerCase()}`, stableHash({ ...input, password: stableHash(input.password) })));
  }

  async disableUser(actor: ActorSnapshot, userId: string, revision: number): Promise<void> {
    requireRole(actor, "ADMIN");
    if (actor.userId === userId) throw new Error("不能停用当前登录用户");
    await this.db.write(command(actor, "USER_DISABLED", "user", userId, [
      { sql: "UPDATE iam_user SET status = 'DISABLED', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?", params: [nowIso(), userId, revision], expectChanges: 1 },
      { sql: "UPDATE iam_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", params: [nowIso(), userId] },
    ], { before: revision, after: revision + 1 }));
  }

  async listPeriods(): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM cfg_accounting_period ORDER BY period DESC", mode: "all" });
  }

  async createPeriod(actor: ActorSnapshot, input: PeriodInput): Promise<void> {
    requireRole(actor, "ADMIN"); const id = newId(); const timestamp = nowIso();
    await this.db.write(command(actor, "PERIOD_CREATED", "accounting_period", id, [{
      sql: "INSERT INTO cfg_accounting_period(id, period, status, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      params: [id, input.period, input.status, timestamp, timestamp],
    }], { after: 1 }, `period:${input.period}`, stableHash(input)));
  }

  async updatePeriod(actor: ActorSnapshot, periodId: string, input: UpdatePeriodInput): Promise<void> {
    requireRole(actor, "ADMIN");
    await this.db.write(command(actor, "PERIOD_UPDATED", "accounting_period", periodId, [{
      sql: "UPDATE cfg_accounting_period SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      params: [input.status, nowIso(), periodId, input.revision], expectChanges: 1,
    }], { before: input.revision, after: input.revision + 1 }));
  }

  async listMasterData(): Promise<Record<string, unknown>[]> {
    const [suppliers, banks, accounts] = await Promise.all([
      this.db.read<Record<string, unknown>[]>({ sql: "SELECT 'supplier' AS type, id, code, name, status, revision FROM mst_supplier ORDER BY code", mode: "all" }),
      this.db.read<Record<string, unknown>[]>({ sql: "SELECT 'bank-account' AS type, id, account_tail AS code, name, status, revision FROM mst_bank_account ORDER BY name", mode: "all" }),
      this.db.read<Record<string, unknown>[]>({ sql: `SELECT 'account' AS type, a.id, a.code, a.name, a.status, a.revision,
        CASE WHEN w.account_id IS NULL THEN 0 ELSE 1 END AS expense_whitelisted FROM mst_account a
        LEFT JOIN mst_expense_whitelist w ON w.account_id = a.id ORDER BY a.code`, mode: "all" }),
    ]);
    return [...suppliers, ...banks, ...accounts];
  }

  async createMasterData(actor: ActorSnapshot, input: MasterDataInput): Promise<void> {
    requireRole(actor, "ADMIN"); const id = newId(); const timestamp = nowIso();
    const statements: WriteCommand["statements"] = input.type === "supplier"
      ? [{ sql: "INSERT INTO mst_supplier(id, code, name, status, revision, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', 1, ?, ?)", params: [id, input.code, input.name, timestamp, timestamp] }]
      : input.type === "bank-account"
        ? [{ sql: "INSERT INTO mst_bank_account(id, name, account_tail, status, revision, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', 1, ?, ?)", params: [id, input.name, input.accountTail, timestamp, timestamp] }]
        : [
          { sql: "INSERT INTO mst_account(id, code, name, status, revision, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', 1, ?, ?)", params: [id, input.code, input.name, timestamp, timestamp] },
          ...(input.expenseWhitelisted ? [{ sql: "INSERT INTO mst_expense_whitelist(account_id, revision, created_at) VALUES (?, 1, ?)", params: [id, timestamp] }] : []),
        ];
    await this.db.write(command(actor, "MASTER_DATA_CREATED", input.type, id, statements, { after: 1 }));
  }

  async disableMasterData(actor: ActorSnapshot, type: MasterDataInput["type"], id: string, revision: number): Promise<void> {
    requireRole(actor, "ADMIN");
    const updateSql = {
      supplier: "UPDATE mst_supplier SET status = 'DISABLED', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      "bank-account": "UPDATE mst_bank_account SET status = 'DISABLED', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      account: "UPDATE mst_account SET status = 'DISABLED', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
    }[type];
    await this.db.write(command(actor, "MASTER_DATA_DISABLED", type, id, [{
      sql: updateSql,
      params: [nowIso(), id, revision], expectChanges: 1,
    }], { before: revision, after: revision + 1 }));
  }
}
