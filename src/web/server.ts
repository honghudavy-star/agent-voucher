import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionContext } from "@agent-voucher/access-workspace";
import {
  BootstrapSchema, CreateUserSchema, LoginSchema, MasterDataSchema, PeriodSchema, UpdatePeriodSchema, UpdateWorkspaceSchema,
  type AccessWorkspaceService,
} from "@agent-voucher/access-workspace";
import type { Role } from "@agent-voucher/shared-kernel";
import type { RuntimeAuditService } from "@agent-voucher/runtime-audit";
import { BankMappingProfileSchema, EvidenceRevisionIdSchema, InvoiceFieldSchema } from "@agent-voucher/document-understanding";
import { asConnectorId } from "@agent-voucher/online-acquisition";
import type { DbClient } from "../infrastructure/db/client.js";
import type { GraphClient } from "../infrastructure/graph/client.js";
import { createBackup } from "../runtime/backup.js";
import { packageRoot } from "../runtime/package-root.js";
import type { Phase2Runtime } from "../runtime/phase2.js";
import {
  appLayout, auditPage, backupsPage, bankImportDetailPage, bankImportsPage, bankMappingPage, bankPreviewPage,
  evidenceDetailPage, evidenceListPage, feishuConnectionsPage, importsPage, invoiceDetailPage, invoiceExtractionsPage,
  jobsPage, loginPage, masterDataPage, periodsPage, quarantinePage, setupPage, syncRunDetailPage, syncRunsPage, usersPage,
  workspaceEditPage, workspacePage,
} from "./views.js";

interface ServerOptions {
  host: string;
  port: number;
  lanMode: boolean;
  dataDir: string;
  access: AccessWorkspaceService;
  runtime: RuntimeAuditService;
  phase2: Phase2Runtime;
  db: DbClient;
  graph: GraphClient;
  logger?: boolean;
}

type FormData = Record<string, string | string[] | undefined>;
const SESSION_COOKIE = "av_session";
const CSRF_COOKIE = "av_csrf";
const LOGIN_NONCE_COOKIE = "av_login_nonce";
const isLoopbackAddress = (address: string): boolean => address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");

const form = (request: FastifyRequest): FormData => (request.body ?? {}) as FormData;
const field = (data: FormData, key: string): string => Array.isArray(data[key]) ? String(data[key]?.[0] ?? "") : String(data[key] ?? "");

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : host.startsWith("fd") || host.startsWith("fe80:");
}

function requireRole(session: SessionContext, ...roles: Role[]): void {
  if (!roles.some((role) => session.actor.roles.includes(role))) {
    const error = new Error("无权访问此页面");
    Object.assign(error, { statusCode: 403 });
    throw error;
  }
}

function csrfFrom(request: FastifyRequest): string { return request.cookies[CSRF_COOKIE] ?? ""; }

function requireCsrf(request: FastifyRequest, session: SessionContext, access: AccessWorkspaceService): void {
  const sent = field(form(request), "csrf_token");
  if (!sent || !access.verifyCsrf(session, sent) || !equalSecret(sent, csrfFrom(request))) {
    const error = new Error("安全令牌无效，请刷新页面后重试");
    Object.assign(error, { statusCode: 403 });
    throw error;
  }
}

function requireCsrfValue(request: FastifyRequest, session: SessionContext, access: AccessWorkspaceService, sent: string): void {
  if (!sent || !access.verifyCsrf(session, sent) || !equalSecret(sent, csrfFrom(request))) {
    const error = new Error("安全令牌无效，请刷新页面后重试"); Object.assign(error, { statusCode: 403 }); throw error;
  }
}

function multipartField(fields: Record<string, unknown>, key: string): string {
  const item = fields[key];
  if (!item || typeof item !== "object" || !("value" in item)) return "";
  const value = (item as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

function optionalField(data: FormData, key: string): string | undefined {
  const value = field(data, key).trim(); return value || undefined;
}

async function authenticated(request: FastifyRequest, reply: FastifyReply): Promise<SessionContext | undefined> {
  if (!request.sessionContext) {
    await reply.redirect("/auth/login");
    return undefined;
  }
  return request.sessionContext;
}

function renderApp(reply: FastifyReply, request: FastifyRequest, session: SessionContext, title: string, activePath: string, lanMode: boolean, content: string) {
  return reply.type("text/html; charset=utf-8").send(appLayout({
    title, activePath, actor: session.actor, csrfToken: csrfFrom(request), lanMode, content,
  }));
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: process.env.AGENT_VOUCHER_LOG_LEVEL ?? "info",
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"],
    },
    trustProxy: false,
    bodyLimit: 64 * 1024,
    forceCloseConnections: true,
  });
  app.decorateRequest("sessionContext", null);
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 10, parts: 12, headerPairs: 200 } });
  await app.register(rateLimit, { global: false });
  await app.register(helmet, {
    global: true,
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(fastifyStatic, { root: join(packageRoot, "assets"), prefix: "/assets/", immutable: true, maxAge: "1d" });

  app.addHook("onRequest", async (request, reply) => {
    if (!isPrivateHost(request.hostname)) return reply.code(400).send("Host不在允许的本地/私有网络范围内");
    if (!options.lanMode && !["localhost", "127.0.0.1", "::1"].includes(request.hostname.toLowerCase())) {
      return reply.code(400).send("当前实例仅允许localhost访问");
    }
  });

  app.addHook("preHandler", async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.sessionContext = token ? await options.access.getSession(token, request.ip) ?? null : null;
  });

  app.setErrorHandler(async (error, request, reply) => {
    const err = error instanceof Error ? error : new Error("Unknown request error");
    const status = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : err.name === "ZodError" ? 400 : 500;
    if (status >= 500) request.log.error({ err }, "request failed");
    const message = status >= 500 ? "服务器处理失败，请查看本地日志" : err.name === "ZodError" ? "输入格式不符合要求" : err.message;
    if (status === 403 && request.sessionContext) {
      await options.runtime.recordRejected(
        request.sessionContext.actor,
        "REQUEST_REJECTED",
        request.routeOptions.url ?? "unknown-route",
        request.method,
      ).catch(() => undefined);
    }
    if (request.headers["hx-request"] === "true") return reply.code(status).type("text/plain; charset=utf-8").send(message);
    return reply.code(status).type("text/plain; charset=utf-8").send(message);
  });

  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const [database, graph] = await Promise.all([options.db.health(), options.graph.health()]);
    const ready = database.quickCheck === "ok" && database.foreignKeys === 1;
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "read-only", database, graph });
  });

  app.get("/", async (_request, reply) => reply.redirect(await options.access.isSetup() ? "/workspace" : "/setup"));

  app.get("/setup", async (request, reply) => {
    if (await options.access.isSetup()) return reply.redirect("/auth/login");
    if (!isLoopbackAddress(request.ip)) {
      return reply.code(403).type("text/html; charset=utf-8").send(setupPage("首次初始化请在安装电脑上完成", options.lanMode, false));
    }
    return reply.type("text/html; charset=utf-8").send(setupPage(undefined, options.lanMode));
  });
  app.post("/setup", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (await options.access.isSetup()) return reply.redirect("/auth/login");
    if (!isLoopbackAddress(request.ip)) {
      await options.runtime.recordRejected({ userId: "SYSTEM", username: "setup", roles: ["ADMIN"], ipAddress: request.ip }, "SETUP_REJECTED", "workspace", "default");
      return reply.code(403).type("text/html; charset=utf-8").send(setupPage("首次初始化请在安装电脑上完成", options.lanMode, false));
    }
    const parsed = BootstrapSchema.parse(form(request));
    await options.access.bootstrap(parsed);
    return reply.redirect("/auth/login");
  });

  app.get("/auth/login", async (_request, reply) => {
    if (!await options.access.isSetup()) return reply.redirect("/setup");
    const nonce = randomBytes(24).toString("base64url");
    reply.setCookie(LOGIN_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: 600 });
    return reply.type("text/html; charset=utf-8").send(loginPage(nonce, undefined, options.lanMode));
  });
  app.post("/auth/login", { config: { rateLimit: { max: 5, timeWindow: "15 minutes", ban: 2 } } }, async (request, reply) => {
    const data = form(request); const nonce = field(data, "login_nonce"); const cookieNonce = request.cookies[LOGIN_NONCE_COOKIE] ?? "";
    if (!nonce || !cookieNonce || !equalSecret(nonce, cookieNonce)) return reply.code(403).type("text/html").send(loginPage("", "登录安全令牌无效", options.lanMode));
    const input = LoginSchema.parse(data);
    try {
      const session = await options.access.authenticate(input, request.ip);
      reply.clearCookie(LOGIN_NONCE_COOKIE, { path: "/" });
      reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: 8 * 60 * 60 });
      reply.setCookie(CSRF_COOKIE, session.csrfToken, { httpOnly: false, sameSite: "strict", secure: false, path: "/", maxAge: 8 * 60 * 60 });
      return reply.redirect("/workspace");
    } catch {
      return reply.code(401).type("text/html").send(loginPage(nonce, "用户名或密码错误", options.lanMode));
    }
  });
  app.post("/auth/logout", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    requireCsrf(request, session, options.access);
    await options.access.revokeSession(session.actor, session.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" }); reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return reply.redirect("/auth/login");
  });

  app.get("/workspace", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const [workspace, jobs, audit] = await Promise.all([options.access.getWorkspace(), options.runtime.listJobs(5), options.runtime.listAudit(5)]);
    if (!workspace) return reply.code(500).send("工作区未初始化");
    return renderApp(reply, request, session, "工作区", "/workspace", options.lanMode, workspacePage(workspace, jobs, audit));
  });
  app.get("/workspace/edit", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN");
    const workspace = await options.access.getWorkspace(); if (!workspace) return reply.code(500).send("工作区未初始化");
    return renderApp(reply, request, session, "编辑工作区", "/workspace", options.lanMode, workspaceEditPage(workspace, csrfFrom(request)));
  });
  app.post("/workspace", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    await options.access.updateWorkspace(session.actor, UpdateWorkspaceSchema.parse(form(request)));
    return reply.redirect("/workspace");
  });

  app.get("/admin/users", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN");
    return renderApp(reply, request, session, "用户与权限", "/admin/users", options.lanMode, usersPage(await options.access.listUsers(), csrfFrom(request)));
  });
  app.post("/admin/users", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const data = form(request); const rawRoles = data.roles; const roles = Array.isArray(rawRoles) ? rawRoles : rawRoles ? [rawRoles] : [];
    await options.access.createUser(session.actor, CreateUserSchema.parse({ ...data, roles }));
    return reply.redirect("/admin/users");
  });
  app.post("/admin/users/:id/disable", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await options.access.disableUser(session.actor, params.id, z.coerce.number().int().parse(field(form(request), "revision")));
    return reply.redirect("/admin/users");
  });

  app.get("/accounting-periods", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN");
    return renderApp(reply, request, session, "会计期间", "/accounting-periods", options.lanMode, periodsPage(await options.access.listPeriods(), csrfFrom(request)));
  });
  app.post("/accounting-periods", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    await options.access.createPeriod(session.actor, PeriodSchema.parse(form(request))); return reply.redirect("/accounting-periods");
  });
  app.post("/accounting-periods/:id", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await options.access.updatePeriod(session.actor, params.id, UpdatePeriodSchema.parse(form(request)));
    return reply.redirect("/accounting-periods");
  });

  app.get("/admin/master-data", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN");
    return renderApp(reply, request, session, "基础资料", "/admin/master-data", options.lanMode, masterDataPage(await options.access.listMasterData(), csrfFrom(request)));
  });
  app.post("/admin/master-data", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    await options.access.createMasterData(session.actor, MasterDataSchema.parse(form(request))); return reply.redirect("/admin/master-data");
  });
  app.post("/admin/master-data/:type/:id/disable", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ type: z.enum(["supplier", "bank-account", "account"]), id: z.string().uuid() }).parse(request.params);
    const revision = z.coerce.number().int().min(1).parse(field(form(request), "revision"));
    await options.access.disableMasterData(session.actor, params.type, params.id, revision);
    return reply.redirect("/admin/master-data");
  });

  app.get("/imports", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR");
    return renderApp(reply, request, session, "资料导入", "/imports", options.lanMode, importsPage(csrfFrom(request)));
  });
  app.post("/imports", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR");
    const part = await request.file(); if (!part) return reply.code(400).send("请选择文件");
    const fields = part.fields as unknown as Record<string, unknown>;
    requireCsrfValue(request, session, options.access, multipartField(fields, "csrf_token"));
    const kind = z.enum(["BANK_STATEMENT", "INVOICE", "CONTRACT_FILE"]).parse(multipartField(fields, "kind"));
    const result = await options.phase2.evidence.ingest({
      kind, sourceKind: "LOCAL_UPLOAD", originalName: part.filename, declaredMediaType: part.mimetype,
      idempotencyKey: `local:${session.actor.userId}:${randomUUID()}`, actor: session.actor, chunks: part.file,
    });
    if (result.status === "QUARANTINED") return reply.redirect("/quarantine");
    if (kind === "INVOICE") await options.runtime.enqueueJob(session.actor, {
      type: "INVOICE_PARSE", lane: "PARSER", payload: { evidenceId: result.evidenceId }, dedupeKey: `invoice-parse:${result.revisionId}`,
    });
    return reply.redirect(`/evidence/${encodeURIComponent(result.evidenceId)}`);
  });

  app.get("/evidence", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    return renderApp(reply, request, session, "证据库", "/evidence", options.lanMode, evidenceListPage(await options.phase2.evidence.list()));
  });
  app.get("/evidence/:id", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const item = await options.phase2.evidence.get(params.id); if (!item) return reply.code(404).send("证据不存在");
    return renderApp(reply, request, session, "证据详情", "/evidence", options.lanMode, evidenceDetailPage(
      item, await options.phase2.evidence.revisionHistory(params.id), await options.phase2.evidence.sourceHistory(params.id),
    ));
  });
  app.get("/evidence/:id/download", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const item = await options.phase2.evidence.get(params.id); if (!item) return reply.code(404).send("证据不存在");
    const path = await options.phase2.evidence.verifiedObjectPath(params.id); const filename = String(item.original_name).replace(/[\r\n]/g, "_");
    return reply.header("X-Content-Type-Options", "nosniff").header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .type(String(item.media_type)).send(createReadStream(path));
  });

  app.get("/imports/bank/:id/mapping", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR");
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const evidence = await options.phase2.evidence.get(params.id); if (!evidence || evidence.kind !== "BANK_STATEMENT") return reply.code(404).send("银行证据不存在");
    return renderApp(reply, request, session, "银行字段映射", "/imports", options.lanMode, bankMappingPage(evidence, csrfFrom(request)));
  });
  app.post("/imports/bank/:id/preview", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR"); requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params); const data = form(request);
    const evidence = await options.phase2.evidence.get(params.id); if (!evidence || evidence.kind !== "BANK_STATEMENT") return reply.code(404).send("银行证据不存在");
    const amountMode = z.enum(["SIGNED", "DEBIT_CREDIT"]).parse(field(data, "amountMode"));
    const shared = {
      transactionDate: field(data, "transactionDate"), balance: field(data, "balance"),
      ...(optionalField(data, "transactionId") ? { transactionId: optionalField(data, "transactionId") } : {}),
      ...(optionalField(data, "currency") ? { currency: optionalField(data, "currency") } : {}),
      ...(optionalField(data, "counterpartyName") ? { counterpartyName: optionalField(data, "counterpartyName") } : {}),
      ...(optionalField(data, "counterpartyAccount") ? { counterpartyAccount: optionalField(data, "counterpartyAccount") } : {}),
      ...(optionalField(data, "summary") ? { summary: optionalField(data, "summary") } : {}),
      ...(optionalField(data, "accountTail") ? { accountTail: optionalField(data, "accountTail") } : {}),
    };
    const sourceKind = z.enum(["CSV", "SPREADSHEET"]).parse(field(data, "sourceKind"));
    const profile = BankMappingProfileSchema.parse({
      id: randomUUID(), name: field(data, "name"), revision: 1, sourceKind,
      ...(sourceKind === "CSV" ? { csv: { encoding: field(data, "encoding"), delimiter: field(data, "delimiter"), quote: '"', hasBom: true } } : { sheetName: field(data, "sheetName") }),
      headerRow: Number(field(data, "headerRow")), dataStartRow: Number(field(data, "dataStartRow")), order: field(data, "order"),
      columns: amountMode === "SIGNED" ? { ...shared, amountMode, amount: field(data, "amount") } : {
        ...shared, amountMode, debitAmount: field(data, "debitAmount"), creditAmount: field(data, "creditAmount"),
      },
    });
    const parsed = await options.phase2.previewBank({
      evidenceRevisionId: EvidenceRevisionIdSchema.parse(evidence.revision_id), filePath: await options.phase2.evidence.verifiedObjectPath(params.id), contentSha256: String(evidence.content_hash),
    }, profile);
    const suggestion = await options.phase2.documents.findMappingByHeaderSignature(session.actor, parsed.headerSignature);
    return renderApp(reply, request, session, "银行导入预览", "/imports", options.lanMode, bankPreviewPage(params.id, profile, parsed, csrfFrom(request), suggestion?.profile));
  });
  app.post("/imports/bank/:id/commit", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR"); requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params); const data = form(request);
    const profile = BankMappingProfileSchema.parse(JSON.parse(field(data, "profileJson")) as unknown);
    const mappingRevisionId = await options.phase2.documents.saveMapping(
      session.actor, profile, field(data, "headerSignature"), undefined, session.actor.roles.includes("ADMIN") ? "SHARED" : "PRIVATE",
    );
    const overrideReason = field(data, "force") === "true" ? field(data, "overrideReason").trim() : undefined;
    if (field(data, "force") === "true" && !overrideReason) return reply.code(400).send("强制导入必须填写原因");
    await options.runtime.enqueueJob(session.actor, {
      type: "BANK_PARSE", lane: "PARSER", payload: { evidenceId: params.id, mappingRevisionId, ...(overrideReason ? { overrideReason } : {}) },
      dedupeKey: `bank-parse:${params.id}:${mappingRevisionId}`,
    });
    return reply.redirect("/runtime/jobs");
  });

  app.get("/bank-imports", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    return renderApp(reply, request, session, "银行流水", "/evidence", options.lanMode, bankImportsPage(await options.phase2.documents.listBankImports()));
  });
  app.get("/bank-imports/:id", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const item = (await options.phase2.documents.listBankImports(200)).find((candidate) => candidate.id === params.id);
    if (!item) return reply.code(404).send("银行导入不存在");
    return renderApp(reply, request, session, "银行导入详情", "/evidence", options.lanMode, bankImportDetailPage(
      item, await options.phase2.documents.listBankTransactions(params.id), await options.phase2.documents.listBankTransactionHistory(params.id), csrfFrom(request),
    ));
  });
  app.post("/bank-imports/:id/override", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    await options.phase2.documents.overrideBankImport(session.actor, params.id, field(form(request), "reason")); return reply.redirect(`/bank-imports/${params.id}`);
  });
  app.post("/bank-imports/:id/transactions", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params); const data = form(request);
    await options.phase2.documents.addBankTransaction(session.actor, params.id, JSON.parse(field(data, "dataJson")) as unknown, field(data, "reason"));
    return reply.redirect(`/bank-imports/${params.id}`);
  });
  for (const operation of ["correct", "delete"] as const) app.post(`/bank-transactions/:id/${operation}`, async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params); const data = form(request);
    await options.phase2.documents.reviseBankTransaction(session.actor, params.id, z.coerce.number().int().positive().parse(field(data, "revision")), JSON.parse(field(data, "dataJson")) as unknown, field(data, "reason"), operation === "delete");
    return reply.redirect("/bank-imports");
  });

  app.get("/invoice-extractions", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    return renderApp(reply, request, session, "发票提取", "/evidence", options.lanMode, invoiceExtractionsPage(await options.phase2.documents.listInvoiceExtractions()));
  });
  app.get("/invoice-extractions/:id", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const extraction = (await options.phase2.documents.listInvoiceExtractions(200)).find((candidate) => candidate.id === params.id);
    if (!extraction) return reply.code(404).send("发票提取不存在");
    return renderApp(reply, request, session, "发票提取详情", "/evidence", options.lanMode, invoiceDetailPage(
      extraction, await options.phase2.documents.listInvoiceFields(params.id), await options.phase2.documents.listInvoiceFieldHistory(params.id), csrfFrom(request),
    ));
  });
  app.post("/invoice-extractions/:id/fields/:field", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128), field: z.string().min(1) }).parse(request.params); const data = form(request);
    const current = (await options.phase2.documents.listInvoiceFields(params.id)).find((candidate) => candidate.field_name === params.field);
    let normalized: unknown; try { normalized = JSON.parse(field(data, "normalizedValue")) as unknown; } catch { normalized = field(data, "normalizedValue"); }
    await options.phase2.documents.correctInvoiceField(session.actor, params.id, InvoiceFieldSchema.parse({
      name: params.field, rawText: current?.raw_text ?? "[MANUAL_ENTRY_NO_SOURCE]", normalizedValue: normalized, page: current?.source_page ?? 1,
      position: current ? JSON.parse(String(current.source_position_json)) as unknown : { x: 0, y: 0, width: 0, height: 0 },
      ambiguous: false, validationErrors: [],
    }), field(data, "reason"));
    return reply.redirect(`/invoice-extractions/${params.id}`);
  });

  app.get("/sources/feishu", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const { store } = options.phase2.acquisition(session.actor); const availability = await options.phase2.secretStore.availability();
    return renderApp(reply, request, session, "飞书资料来源", "/sources/feishu", options.lanMode, feishuConnectionsPage(
      await store.list(), csrfFrom(request), availability.available ? "可用" : `不可用：${availability.reason ?? "未知原因"}`,
      { canAdmin: session.actor.roles.includes("ADMIN"), canSync: session.actor.roles.some((role) => role === "ADMIN" || role === "OPERATOR") },
    ));
  });
  app.post("/sources/feishu", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN"); requireCsrf(request, session, options.access); const data = form(request);
    const approvalCodes = field(data, "approvalCodes").split(",").map((value) => value.trim()).filter(Boolean);
    const initialDate = field(data, "initialLookbackFrom");
    const expectedRevision = field(data, "expectedRevision");
    await options.phase2.acquisition(session.actor).service.configureFeishu({
      connectorId: "feishu-default", displayName: field(data, "displayName"), platform: z.enum(["FEISHU", "LARK"]).parse(field(data, "platform")),
      appId: field(data, "appId"), appSecret: field(data, "appSecret"),
      approvalCodes, attachmentControlIds: z.record(z.string(), z.array(z.string())).parse(JSON.parse(field(data, "attachmentControlIds")) as unknown),
      initialLookbackFrom: `${initialDate}T00:00:00.000+08:00`, dailySyncTime: field(data, "dailySyncTime"), timeZone: field(data, "timeZone"), overlapHours: 48,
      ...(expectedRevision ? { expectedRevision: z.coerce.number().int().positive().parse(expectedRevision) } : {}),
    });
    return reply.redirect("/sources/feishu");
  });
  app.post("/sources/feishu/:id/test", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN"); requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1) }).parse(request.params); await options.phase2.acquisition(session.actor).service.testConnection(asConnectorId(params.id));
    return reply.redirect("/sources/feishu");
  });
  app.post("/sources/feishu/:id/sync", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR"); requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    await options.runtime.enqueueJob(session.actor, { type: "FEISHU_SYNC", lane: "NETWORK", payload: { connectorId: params.id, trigger: "MANUAL" }, dedupeKey: `feishu-manual:${params.id}:${randomUUID()}` });
    return reply.redirect("/sources/feishu/runs");
  });
  app.post("/sources/feishu/:id/disable", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN"); requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    await options.phase2.acquisition(session.actor).service.disable(asConnectorId(params.id));
    await options.runtime.cancelJobsByPayload(session.actor, "FEISHU_SYNC", "connectorId", params.id);
    return reply.redirect("/sources/feishu");
  });
  app.get("/sources/feishu/runs", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const { store } = options.phase2.acquisition(session.actor);
    return renderApp(reply, request, session, "飞书同步记录", "/sources/feishu", options.lanMode, syncRunsPage(await store.listSyncBatches()));
  });
  app.get("/sources/feishu/runs/:id", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params); const { store } = options.phase2.acquisition(session.actor);
    return renderApp(reply, request, session, "飞书同步批次详情", "/sources/feishu", options.lanMode,
      syncRunDetailPage(await store.listBatchItems(params.id), await store.listBatchAttachments(params.id)));
  });

  app.get("/quarantine", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return;
    return renderApp(reply, request, session, "隔离区", "/quarantine", options.lanMode, quarantinePage(await options.phase2.evidence.listQuarantine(), csrfFrom(request)));
  });
  app.post("/quarantine/:id/purge", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN"); requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params); await options.phase2.evidence.purgeQuarantine(session.actor, params.id);
    return reply.redirect("/quarantine");
  });

  app.get("/runtime/jobs", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR");
    return renderApp(reply, request, session, "运行任务", "/runtime/jobs", options.lanMode, jobsPage(await options.runtime.listJobs(), csrfFrom(request)));
  });
  app.post("/runtime/jobs/health", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    await options.runtime.enqueueHealthCheck(session.actor); return reply.redirect("/runtime/jobs");
  });
  app.post("/runtime/jobs/:id/cancel", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    const params = z.object({ id: z.string().min(1).max(128) }).parse(request.params); await options.runtime.requestCancellation(session.actor, params.id);
    return reply.redirect("/runtime/jobs");
  });

  app.get("/audit", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "REVIEWER");
    return renderApp(reply, request, session, "审计日志", "/audit", options.lanMode, auditPage(await options.runtime.listAudit()));
  });

  app.get("/ops/backups", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN");
    return renderApp(reply, request, session, "备份恢复", "/ops/backups", options.lanMode, backupsPage(await options.runtime.listBackups(), csrfFrom(request)));
  });
  app.post("/ops/backups", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN"); requireCsrf(request, session, options.access);
    await createBackup(options.dataDir, options.db, options.graph, options.runtime, session.actor);
    return reply.redirect("/ops/backups");
  });

  await app.listen({ host: options.host, port: options.port });
  return app;
}
