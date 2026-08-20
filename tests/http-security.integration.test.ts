import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessWorkspaceService } from "@agent-voucher/access-workspace";
import { RuntimeAuditService } from "@agent-voucher/runtime-audit";
import { DbClient } from "../src/infrastructure/db/client.js";
import { GraphClient } from "../src/infrastructure/graph/client.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";
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
  let server: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-voucher-http-"));
    const paths = await prepareDataDir(dataDir);
    db = new DbClient(paths.appDb); graph = new GraphClient(paths.graphDb);
    await db.start(); await graph.start();
    access = new AccessWorkspaceService(db);
    server = await createServer({
      host: "127.0.0.1", port: 0, lanMode: false, dataDir,
      setupTokenValid: (token) => token === "setup-token-for-tests-1234567890",
      access, runtime: new RuntimeAuditService(db, graph), db, graph, logger: false,
    });
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    const setup = await fetch(`${baseUrl}/setup`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "setup-token-for-tests-1234567890", workspaceName: "安全测试", ledgerName: "安全总账",
        username: "admin", displayName: "管理员", password: "Foundation-Test-2026!",
      }),
    });
    expect(setup.status).toBe(302);
  });

  afterEach(async () => {
    await server.close(); await graph.close(); await db.close(); await rm(dataDir, { recursive: true, force: true });
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
