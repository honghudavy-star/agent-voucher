import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessWorkspaceService } from "@agent-voucher/access-workspace";
import { RuntimeAuditService } from "@agent-voucher/runtime-audit";
import { asConnectorId, InMemorySecretStore } from "@agent-voucher/online-acquisition";
import { newId } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { GraphClient } from "../src/infrastructure/graph/client.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";
import { Phase2Runtime } from "../src/runtime/phase2.js";
import { createServer } from "../src/web/server.js";
import type { FastifyInstance } from "fastify";

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookiePair(setCookie: string): string { return setCookie.split(";", 1)[0] ?? ""; }

function requestWithHost(url: URL, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: host } }, (response) => {
      response.resume(); resolve(response.statusCode ?? 0);
    });
    request.on("error", reject); request.end();
  });
}

describe("HTTP security boundary", () => {
  let dataDir: string;
  let db: DbClient;
  let graph: GraphClient;
  let access: AccessWorkspaceService;
  let runtime: RuntimeAuditService;
  let phase2: Phase2Runtime;
  let server: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-voucher-http-"));
    const paths = await prepareDataDir(dataDir);
    db = new DbClient(paths.appDb); graph = new GraphClient(paths.graphDb);
    await db.start(); await graph.start();
    access = new AccessWorkspaceService(db);
    runtime = new RuntimeAuditService(db, graph);
    phase2 = new Phase2Runtime(db, dataDir, new InMemorySecretStore()); await phase2.start();
    server = await createServer({
      host: "127.0.0.1", port: 0, lanMode: false, dataDir,
      access, runtime, phase2, db, graph, logger: false,
    });
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const remoteSetup = await server.inject({
      method: "POST", url: "/setup", remoteAddress: "192.168.2.81",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        workspaceName: "远程工作区", ledgerName: "远程总账", username: "remote",
        displayName: "远程管理员", password: "Foundation-Remote-2026!",
      }).toString(),
    });
    expect(remoteSetup.statusCode).toBe(403);

    const setupPage = await fetch(`${baseUrl}/setup`);
    const setupHtml = await setupPage.text();
    expect(setupPage.status).toBe(200);
    expect(setupHtml).not.toContain('name="token"');
    expect(setupHtml).not.toContain("15分钟");

    const invalidSetup = await fetch(`${baseUrl}/setup`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        workspaceName: "不能创建", ledgerName: "不能创建",
        username: "中文用户名", displayName: "管理员", password: "Foundation-Test-2026!",
      }),
    });
    expect(invalidSetup.status).toBe(400);
    const setup = await fetch(`${baseUrl}/setup`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        workspaceName: "安全测试", ledgerName: "安全总账",
        username: "admin", displayName: "管理员", password: "Foundation-Test-2026!",
      }),
    });
    expect(setup.status).toBe(302);
  });

  it("keeps bootstrap closed after the first local administrator and audits remote attempts", async () => {
    const response = await fetch(`${baseUrl}/setup`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        workspaceName: "重复", ledgerName: "重复", username: "other",
        displayName: "Other", password: "Foundation-Test-2026!",
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login");
    expect(await access.getWorkspace()).toMatchObject({ display_name: "安全测试", ledger_name: "安全总账" });
    const rejected = (await runtime.listAudit()).filter((item) => item.action === "SETUP_REJECTED");
    expect(rejected).toHaveLength(1);
    expect(JSON.stringify(rejected)).not.toContain("Foundation-Remote-2026");
  });

  afterEach(async () => {
    phase2.stop(); await server.close(); await graph.close(); await db.close(); await rm(dataDir, { recursive: true, force: true });
  });

  async function login(username = "admin", password = "Foundation-Test-2026!") {
    const loginPage = await fetch(`${baseUrl}/auth/login`);
    const html = await loginPage.text();
    const nonce = /name="login_nonce" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const nonceCookie = cookiePair(cookies(loginPage).find((item) => item.startsWith("av_login_nonce=")) ?? "");
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${nonceCookie}; av_session=attacker-fixed-token` },
      body: new URLSearchParams({ login_nonce: nonce, username, password }),
    });
    return { response, setCookies: cookies(response) };
  }

  it("rotates the session, sets strict cookies and blocks missing CSRF", async () => {
    const { response, setCookies } = await login();
    expect(response.status).toBe(302);
    const sessionCookie = setCookies.find((item) => item.startsWith("av_session=")) ?? "";
    const csrfCookie = setCookies.find((item) => item.startsWith("av_csrf=")) ?? "";
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie.toLowerCase()).toContain("samesite=strict");
    expect(sessionCookie).not.toContain("attacker-fixed-token");
    expect(csrfCookie).not.toContain("HttpOnly");
    const unauthorized = await fetch(`${baseUrl}/runtime/jobs/health`, {
      method: "POST", redirect: "manual", headers: { cookie: cookiePair(sessionCookie) },
    });
    expect(unauthorized.status).toBe(403);
  });

  it("blocks admin pages for operators and rejects untrusted Host headers", async () => {
    await access.createUser({ userId: "seed", username: "seed", roles: ["ADMIN"] }, {
      username: "operator", displayName: "操作员", password: "Operator-Test-2026!", roles: ["OPERATOR"],
    });
    const { setCookies } = await login("operator", "Operator-Test-2026!");
    const operatorCookies = setCookies.filter((item) => item.startsWith("av_session=") || item.startsWith("av_csrf=")).map(cookiePair).join("; ");
    const users = await fetch(`${baseUrl}/admin/users`, { headers: { cookie: operatorCookies }, redirect: "manual" });
    expect(users.status).toBe(403);
    const csrfPair = cookiePair(setCookies.find((item) => item.startsWith("av_csrf=")) ?? "");
    const backup = await fetch(`${baseUrl}/ops/backups`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: operatorCookies },
      body: new URLSearchParams({ csrf_token: csrfPair.slice(csrfPair.indexOf("=") + 1) }),
    });
    expect(backup.status).toBe(403); expect(await runtime.listBackups()).toHaveLength(0);
    expect(await requestWithHost(new URL(`${baseUrl}/health/live`), "evil.example")).toBe(400);
  });

  it("applies security headers without forcing HTTPS in explicit HTTP mode", async () => {
    const response = await fetch(`${baseUrl}/auth/login`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("streams authenticated Phase 2 uploads into the evidence vault and forces attachment downloads", async () => {
    const { setCookies } = await login();
    const sessionPair = cookiePair(setCookies.find((item) => item.startsWith("av_session=")) ?? "");
    const csrfPair = cookiePair(setCookies.find((item) => item.startsWith("av_csrf=")) ?? "");
    const csrf = csrfPair.slice(csrfPair.indexOf("=") + 1); const cookie = `${sessionPair}; ${csrfPair}`;
    const payload = new FormData(); payload.append("csrf_token", csrf); payload.append("kind", "BANK_STATEMENT");
    payload.append("file", new Blob(["日期,金额,余额\n2026-08-01,1.00,1.00\n"], { type: "text/csv" }), "bank.csv");
    const upload = await fetch(`${baseUrl}/imports`, { method: "POST", redirect: "manual", headers: { cookie }, body: payload });
    expect(upload.status).toBe(302); const location = upload.headers.get("location") ?? ""; expect(location).toMatch(/^\/evidence\//);
    const detail = await fetch(`${baseUrl}${location}`, { headers: { cookie } }); expect(await detail.text()).toContain("bank.csv");
    const download = await fetch(`${baseUrl}${location}/download`, { headers: { cookie } });
    expect(download.headers.get("content-disposition")).toContain("attachment"); expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await download.text()).toContain("2026-08-01");
  });

  it("rejects a stale Feishu configuration revision without changing the winning secret", async () => {
    const { setCookies } = await login();
    const sessionPair = cookiePair(setCookies.find((item) => item.startsWith("av_session=")) ?? "");
    const csrfPair = cookiePair(setCookies.find((item) => item.startsWith("av_csrf=")) ?? "");
    const csrf = csrfPair.slice(csrfPair.indexOf("=") + 1); const cookie = `${sessionPair}; ${csrfPair}`;
    const connectorForm = (displayName: string, appSecret: string, expectedRevision?: number) => new URLSearchParams({
      csrf_token: csrf, displayName, platform: "LARK", appId: "cli_test", appSecret,
      approvalCodes: "APPROVAL_1", attachmentControlIds: "{}", initialLookbackFrom: "2026-08-01",
      dailySyncTime: "02:00", timeZone: "Asia/Shanghai",
      ...(expectedRevision === undefined ? {} : { expectedRevision: String(expectedRevision) }),
    });
    const post = (body: URLSearchParams) => fetch(`${baseUrl}/sources/feishu`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body,
    });

    expect((await post(connectorForm("初始连接", "secret-v1"))).status).toBe(302);
    expect((await post(connectorForm("获胜更新", "secret-v2", 1))).status).toBe(302);
    expect((await post(connectorForm("过期更新", "stale-secret", 1))).status).toBe(409);
    const acquisition = phase2.acquisition({ userId: "test", username: "test", roles: ["ADMIN"] });
    const stored = await acquisition.store.get(asConnectorId("feishu-default"));
    expect(stored).toMatchObject({ displayName: "获胜更新", revision: 2 });
    expect(await phase2.secretStore.read(stored!.secretReference)).toBe("secret-v2");
  });

  it("allows an authenticated operator to add an invoice field missing from the parser result", async () => {
    const timestamp = new Date().toISOString();
    await db.write({
      commandId: newId(), commandType: "TEST_INVOICE_EXTRACTION", commandVersion: 1, correlationId: newId(),
      actor: { userId: "test-admin", username: "admin", roles: ["ADMIN"] },
      statements: [{
        sql: `INSERT INTO doc_invoice_extraction(id, evidence_revision_id, parser_version, status, validation_errors_json, active_revision, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        params: ["invoice-manual-entry", "evidence-revision-test", "test-parser", "PARTIAL_TEXT", "[]", timestamp, timestamp],
      }],
      audit: { action: "TEST_INVOICE_EXTRACTION", objectType: "invoice_extraction", objectId: "invoice-manual-entry", result: "SUCCESS" },
    });
    const { setCookies } = await login();
    const sessionPair = cookiePair(setCookies.find((item) => item.startsWith("av_session=")) ?? "");
    const csrfPair = cookiePair(setCookies.find((item) => item.startsWith("av_csrf=")) ?? "");
    const csrf = csrfPair.slice(csrfPair.indexOf("=") + 1);
    const response = await fetch(`${baseUrl}/invoice-extractions/invoice-manual-entry/fields/buyerName`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${sessionPair}; ${csrfPair}` },
      body: new URLSearchParams({ csrf_token: csrf, normalizedValue: "测试购方", reason: "PDF 文字层缺失，人工补录" }),
    });
    expect(response.status).toBe(302);
    expect(await phase2.documents.listInvoiceFields("invoice-manual-entry")).toEqual([
      expect.objectContaining({ field_name: "buyerName", raw_text: "[MANUAL_ENTRY_NO_SOURCE]", normalized_value_json: '"测试购方"' }),
    ]);
  });

  it("rate-limits repeated invalid logins without exposing user existence", async () => {
    const loginPage = await fetch(`${baseUrl}/auth/login`);
    const html = await loginPage.text();
    const nonce = /name="login_nonce" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const nonceCookie = cookiePair(cookies(loginPage)[0] ?? "");
    const statuses: number[] = [];
    const bodies: string[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
        body: new URLSearchParams({ login_nonce: nonce, username: "missing-user", password: "wrong-password" }),
      });
      statuses.push(response.status); bodies.push(await response.text());
    }
    expect(statuses).toContain(429);
    expect(bodies.filter((body) => body.includes("用户名或密码错误")).length).toBeGreaterThan(0);
    expect(bodies.join(" ")).not.toContain("missing-user");
  }, 20_000);

  it("closes promptly even when a browser-style keep-alive connection exists", async () => {
    const address = new URL(`${baseUrl}/health/live`);
    const agent = new HttpAgent({ keepAlive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest({ hostname: address.hostname, port: address.port, path: address.pathname, agent }, (response) => {
          response.resume(); response.on("end", resolve);
        });
        request.on("error", reject); request.end();
      });
      const result = await Promise.race([
        server.close().then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2000)),
      ]);
      expect(result).toBe("closed");
    } finally { agent.destroy(); }
  });
});
