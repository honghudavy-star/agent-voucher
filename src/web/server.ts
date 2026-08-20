import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
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
import type { DbClient } from "../infrastructure/db/client.js";
import type { GraphClient } from "../infrastructure/graph/client.js";
import { createBackup } from "../runtime/backup.js";
import { packageRoot } from "../runtime/package-root.js";
import {
  appLayout, auditPage, backupsPage, jobsPage, loginPage, masterDataPage, periodsPage,
  setupPage, usersPage, workspaceEditPage, workspacePage,
} from "./views.js";

interface ServerOptions {
  host: string;
  port: number;
  lanMode: boolean;
  dataDir: string;
  setupTokenValid(token: string): boolean;
  access: AccessWorkspaceService;
  runtime: RuntimeAuditService;
  db: DbClient;
  graph: GraphClient;
  logger?: boolean;
}

type FormData = Record<string, string | string[] | undefined>;
const SESSION_COOKIE = "av_session";
const CSRF_COOKIE = "av_csrf";
const LOGIN_NONCE_COOKIE = "av_login_nonce";

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

  app.get("/setup", async (_request, reply) => {
    if (await options.access.isSetup()) return reply.redirect("/auth/login");
    return reply.type("text/html; charset=utf-8").send(setupPage());
  });
  app.post("/setup", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = BootstrapSchema.parse(form(request));
    if (!options.setupTokenValid(parsed.token)) return reply.code(403).type("text/html").send(setupPage("初始化链接无效或已过期"));
    await options.access.bootstrap(parsed);
    return reply.redirect("/auth/login");
  });

  app.get("/auth/login", async (_request, reply) => {
    if (!await options.access.isSetup()) return reply.redirect("/setup");
    const nonce = randomBytes(24).toString("base64url");
    reply.setCookie(LOGIN_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: 600 });
    return reply.type("text/html; charset=utf-8").send(loginPage(nonce));
  });
  app.post("/auth/login", { config: { rateLimit: { max: 5, timeWindow: "15 minutes", ban: 2 } } }, async (request, reply) => {
    const data = form(request); const nonce = field(data, "login_nonce"); const cookieNonce = request.cookies[LOGIN_NONCE_COOKIE] ?? "";
    if (!nonce || !cookieNonce || !equalSecret(nonce, cookieNonce)) return reply.code(403).type("text/html").send(loginPage("", "登录安全令牌无效"));
    const input = LoginSchema.parse(data);
    try {
      const session = await options.access.authenticate(input, request.ip);
      reply.clearCookie(LOGIN_NONCE_COOKIE, { path: "/" });
      reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: 8 * 60 * 60 });
      reply.setCookie(CSRF_COOKIE, session.csrfToken, { httpOnly: false, sameSite: "strict", secure: false, path: "/", maxAge: 8 * 60 * 60 });
      return reply.redirect("/workspace");
    } catch {
      return reply.code(401).type("text/html").send(loginPage(nonce, "用户名或密码错误"));
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

  app.get("/runtime/jobs", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireRole(session, "ADMIN", "OPERATOR");
    return renderApp(reply, request, session, "运行任务", "/runtime/jobs", options.lanMode, jobsPage(await options.runtime.listJobs(), csrfFrom(request)));
  });
  app.post("/runtime/jobs/health", async (request, reply) => {
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    await options.runtime.enqueueHealthCheck(session.actor); return reply.redirect("/runtime/jobs");
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
    const session = await authenticated(request, reply); if (!session) return; requireCsrf(request, session, options.access);
    await createBackup(options.dataDir, options.db, options.graph, options.runtime, session.actor);
    return reply.redirect("/ops/backups");
  });

  await app.listen({ host: options.host, port: options.port });
  return app;
}
