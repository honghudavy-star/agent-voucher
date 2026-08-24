import { describe, expect, it } from "vitest";
import { appLayout, feishuConnectionsPage, loginPage, masterDataPage, periodsPage, setupPage, usersPage, workspacePage } from "../src/web/views.js";

describe("server-rendered UI", () => {
  it("escapes untrusted workspace and audit values", () => {
    const page = workspacePage(
      { display_name: '<script>alert("x")</script>', ledger_name: "Ledger" },
      [],
      [{ occurred_at: new Date().toISOString(), actor_username: "<img src=x onerror=1>", action: "LOGIN", object_type: "session", object_id: "1", result: "SUCCESS" }],
    );
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;script&gt;");
  });

  it("renders the locked A01/A02 navigation and LAN warning", () => {
    const html = appLayout({
      title: "工作区", activePath: "/workspace", actor: { userId: "1", username: "admin", roles: ["ADMIN"] },
      csrfToken: "csrf", lanMode: true, content: "<h1>工作区概览</h1>",
    });
    for (const label of ["工作区", "用户与权限", "基础资料", "会计期间", "运行任务", "审计日志", "备份恢复"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("不安全局域网模式");
    expect(html).not.toContain("OCR");
    expect(html).not.toContain("凭证草稿");
  });

  it("associates every administrative form control with an accessible label", () => {
    const users = usersPage([], "csrf");
    expect(users).toContain('for="new-user-username"');
    expect(users).toContain('id="new-user-username"');
    const periods = periodsPage([], "csrf");
    expect(periods).toContain('for="new-period"');
    expect(periods).toContain('id="new-period"');
    const master = masterDataPage([], "csrf");
    expect(master).toContain('for="master-data-type"');
    expect(master).toContain('id="master-data-type"');
  });

  it("carries the current Feishu revision in the admin update form", () => {
    const html = feishuConnectionsPage([{
      id: "feishu-default", display_name: "Lark", platform: "LARK", app_id: "cli_test", status: "ACTIVE",
      approval_codes_json: "[]", daily_sync_time: "02:00", revision: 3,
    }], "csrf", "可用", { canAdmin: true, canSync: true });
    expect(html).toContain('name="expectedRevision" value="3"');
  });

  it("renders LAN warnings on public pages and confirmation contracts on disable forms", () => {
    const setup = setupPage(undefined, true);
    expect(setup).toContain('role="alert"');
    expect(setup).not.toContain('name="token"');
    expect(setup).not.toContain("15分钟");
    expect(setupPage("首次初始化请在安装电脑上完成", true, false)).not.toContain("<form");
    expect(loginPage("nonce", undefined, true)).toContain("不安全局域网模式");
    const users = usersPage([{ id: "1", username: "u", display_name: "U", roles: "OPERATOR", status: "ACTIVE", revision: 1 }], "csrf");
    expect(users).toContain("data-confirm=");
    const master = masterDataPage([{ id: "1", type: "supplier", code: "S1", name: "供应商", status: "ACTIVE", revision: 1 }], "csrf");
    expect(master).toContain("确认停用");
  });
});
