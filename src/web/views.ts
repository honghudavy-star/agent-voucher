import { join } from "node:path";
import { Eta } from "eta";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import { escapeHtml } from "@agent-voucher/shared-kernel";
import { packageRoot } from "../runtime/package-root.js";

const eta = new Eta({ views: join(packageRoot, "templates"), cache: true });

const icons: Record<string, string> = {
  workspace: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/>',
  users: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><path d="M16 3.5a4 4 0 0 1 0 7"/><path d="M17 15a5 5 0 0 1 4 4v2"/>',
  data: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  calendar: '<path d="M5 3v4M19 3v4M3 9h18M5 5h14a2 2 0 0 1 2 2v14H3V7a2 2 0 0 1 2-2Z"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
  audit: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  backup: '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M8 4v4h8V4M8 13h8M9 17h6"/>',
};

const nav = [
  ["/workspace", "工作区", "workspace"],
  ["/admin/users", "用户与权限", "users"],
  ["/admin/master-data", "基础资料", "data"],
  ["/accounting-periods", "会计期间", "calendar"],
  ["/runtime/jobs", "运行任务", "jobs"],
  ["/audit", "审计日志", "audit"],
  ["/ops/backups", "备份恢复", "backup"],
] as const;

function layout(title: string, body: string, publicPage = false): string {
  return eta.render("layout.eta", { title, body, publicPage });
}

function navHtml(activePath: string): string {
  return nav.map(([href, label, icon]) => `<li><a class="nav-link ${activePath === href ? "active" : ""}" href="${href}">
    <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg><span>${label}</span></a></li>`).join("");
}

export function appLayout(options: {
  title: string; activePath: string; actor: ActorSnapshot; csrfToken: string; lanMode: boolean; content: string;
}): string {
  const warning = options.lanMode ? `<div class="lan-warning" role="alert">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 1 21h22L12 2Zm1 15h-2v2h2v-2Zm0-7h-2v5h2v-5Z"/></svg>
    <span>不安全局域网模式：当前连接未加密，仅限受信网络</span></div>` : "";
  return layout(options.title, `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-name">Agent Voucher</div><div class="brand-subtitle">账证基础工作台</div></div>
      <nav aria-label="主导航"><ul class="nav-list">${navHtml(options.activePath)}</ul></nav>
      <div class="sidebar-foot">A01 / A02 · 本地优先</div>
    </aside>
    <div class="content-column">
      <header class="topbar"><div class="user-menu"><span>${escapeHtml(options.actor.username)}</span></div>
        <form class="logout-form" method="post" action="/auth/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}"><button class="link-button" type="submit">退出登录</button></form>
      </header>
      ${warning}
      <main class="main"><div class="flash" data-flash hidden></div>${options.content}</main>
    </div>
  </div>`);
}

export function setupPage(message?: string): string {
  return layout("初始化", `<div class="auth-shell"><div class="auth-brand"><div class="brand-name">Agent Voucher</div><div class="brand-subtitle">账证基础工作台</div></div>
    <section class="auth-card"><h1>初始化工作区</h1><p class="muted">创建唯一工作区、账套和首位管理员。</p>
    ${message ? `<div class="flash">${escapeHtml(message)}</div>` : ""}
    <form method="post" action="/setup">
      <input type="hidden" name="token" data-from-fragment>
      <div class="form-row"><label class="form-label" for="workspaceName">工作区名称</label><input class="form-control" id="workspaceName" name="workspaceName" required maxlength="120"></div>
      <div class="form-row"><label class="form-label" for="ledgerName">账套名称</label><input class="form-control" id="ledgerName" name="ledgerName" required maxlength="120"></div>
      <div class="form-row"><label class="form-label" for="username">管理员用户名</label><input class="form-control" id="username" name="username" required minlength="3" maxlength="64" autocomplete="username"></div>
      <div class="form-row"><label class="form-label" for="displayName">显示名称</label><input class="form-control" id="displayName" name="displayName" required maxlength="80"></div>
      <div class="form-row"><label class="form-label" for="password">管理员密码</label><input class="form-control" id="password" type="password" name="password" required minlength="12" maxlength="256" autocomplete="new-password"></div>
      <div class="form-actions"><button class="button primary" type="submit">创建工作区</button></div>
    </form><p class="auth-note">初始化链接15分钟内有效。密码只在此浏览器表单中提交，不进入命令行或日志。</p></section></div>`, true);
}

export function loginPage(nonce: string, message?: string): string {
  return layout("登录", `<div class="auth-shell"><div class="auth-brand"><div class="brand-name">Agent Voucher</div><div class="brand-subtitle">账证基础工作台</div></div>
    <section class="auth-card"><h1>登录</h1><p class="muted">使用本机工作区账户继续。</p>
    ${message ? `<div class="flash">${escapeHtml(message)}</div>` : ""}
    <form method="post" action="/auth/login"><input type="hidden" name="login_nonce" value="${escapeHtml(nonce)}">
      <div class="form-row"><label class="form-label" for="username">用户名</label><input class="form-control" id="username" name="username" required autocomplete="username"></div>
      <div class="form-row"><label class="form-label" for="password">密码</label><input class="form-control" id="password" type="password" name="password" required autocomplete="current-password"></div>
      <div class="form-actions"><button class="button primary" type="submit">登录</button></div>
    </form></section></div>`, true);
}

const value = (row: Record<string, unknown> | undefined, key: string, fallback = "—") => escapeHtml(row?.[key] ?? fallback);
const dateValue = (input: unknown) => {
  if (typeof input !== "string" && typeof input !== "number" && !(input instanceof Date)) return "—";
  return escapeHtml(new Date(input).toLocaleString("zh-CN", { hour12: false }));
};

export function workspacePage(workspace: Record<string, unknown>, jobs: Record<string, unknown>[], audit: Record<string, unknown>[]): string {
  const jobRows = jobs.slice(0, 5).map((job) => `<tr><td>${value(job,"id")}</td><td>${value(job,"type")}</td><td>${status(value(job,"status"))}</td><td>${dateValue(job.created_at)}</td><td>${dateValue(job.updated_at)}</td></tr>`).join("");
  const auditRows = audit.slice(0, 5).map((item) => `<tr><td>${dateValue(item.occurred_at)}</td><td>${value(item,"actor_username")}</td><td>${value(item,"action")}</td><td>${value(item,"object_type")}</td><td>${value(item,"object_id")}</td><td>${result(value(item,"result"))}</td></tr>`).join("");
  return `<div class="page-header"><div><h1 class="page-title">工作区概览</h1></div><a class="button" href="/workspace/edit">编辑工作区</a></div>
    <section class="workspace-block"><div><div class="workspace-name">${value(workspace,"display_name")}</div><div class="workspace-meta">${value(workspace,"ledger_name")} · 人民币 · 企业会计准则</div></div></section>
    <div class="status-strip"><strong>系统状态</strong><span class="status-ok"><span class="status-dot"></span>运行正常</span></div>
    <h2 class="section-heading">最近任务</h2>${table(["任务 ID","任务类型","状态","开始时间","更新时间"], jobRows, 5)}
    <h2 class="section-heading">最近审计</h2>${table(["时间","用户","操作","对象类型","对象名称/ID","结果"], auditRows, 6)}`;
}

export function workspaceEditPage(workspace: Record<string, unknown>, csrf: string): string {
  return pageHeader("编辑工作区", "只维护必要的工作区和账套显示信息。") + `<section class="form-panel"><form method="post" action="/workspace">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(workspace,"revision","1")}">
    <div class="form-grid"><div class="form-row"><label class="form-label" for="workspace-display-name">工作区名称</label><input class="form-control" id="workspace-display-name" name="displayName" value="${value(workspace,"display_name","")}" required></div>
    <div class="form-row"><label class="form-label" for="workspace-ledger-name">账套名称</label><input class="form-control" id="workspace-ledger-name" name="ledgerName" value="${value(workspace,"ledger_name","")}" required></div></div>
    <div class="form-actions"><a class="button" href="/workspace">取消</a><button class="button primary" type="submit">保存</button></div></form></section>`;
}

export function usersPage(users: Record<string, unknown>[], csrf: string): string {
  const rows = users.map((user) => `<tr><td>${value(user,"username")}</td><td>${value(user,"display_name")}</td><td>${value(user,"roles")}</td><td>${status(value(user,"status"))}</td><td>${dateValue(user.created_at)}</td><td>
    ${user.status === "ACTIVE" ? `<form method="post" action="/admin/users/${value(user,"id")}/disable"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(user,"revision")}"><button class="button danger small" type="submit">停用</button></form>` : "—"}</td></tr>`).join("");
  return pageHeader("用户与权限", "固定角色：管理员、操作员、复核员。") + `<section class="form-panel"><form method="post" action="/admin/users">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="form-grid">
    <div class="form-row"><label class="form-label" for="new-user-username">用户名</label><input class="form-control" id="new-user-username" name="username" required></div>
    <div class="form-row"><label class="form-label" for="new-user-display-name">显示名称</label><input class="form-control" id="new-user-display-name" name="displayName" required></div>
    <div class="form-row"><label class="form-label" for="new-user-password">初始密码</label><input class="form-control" id="new-user-password" type="password" name="password" minlength="12" required></div>
    <div class="form-row"><span class="form-label">角色</span><div class="checkbox-row"><label><input type="checkbox" name="roles" value="ADMIN"> 管理员</label><label><input type="checkbox" name="roles" value="OPERATOR" checked> 操作员</label><label><input type="checkbox" name="roles" value="REVIEWER"> 复核员</label></div></div></div>
    <div class="form-actions"><button class="button primary" type="submit">创建用户</button></div></form></section>
    ${table(["用户名","显示名称","角色","状态","创建时间","操作"], rows, 6)}`;
}

export function periodsPage(periods: Record<string, unknown>[], csrf: string): string {
  const rows = periods.map((period) => `<tr><td>${value(period,"period")}</td><td>${status(value(period,"status"))}</td><td>${value(period,"revision")}</td><td>${dateValue(period.created_at)}</td><td>
    <form method="post" action="/accounting-periods/${value(period,"id")}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(period,"revision")}">
    <select class="form-control compact-control" name="status" aria-label="${value(period,"period")}期间状态"><option value="OPEN" ${period.status === "OPEN" ? "selected" : ""}>开放</option><option value="CLOSED" ${period.status === "CLOSED" ? "selected" : ""}>关闭</option></select><button class="button small" type="submit">更新</button></form></td></tr>`).join("");
  return pageHeader("会计期间", "期间状态属于版本化工作区配置。") + `<section class="form-panel"><form method="post" action="/accounting-periods"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="form-grid">
    <div class="form-row"><label class="form-label" for="new-period">期间</label><input class="form-control" id="new-period" type="month" name="period" required></div><div class="form-row"><label class="form-label" for="new-period-status">状态</label><select class="form-control" id="new-period-status" name="status"><option value="OPEN">开放</option><option value="CLOSED">关闭</option></select></div></div>
    <div class="form-actions"><button class="button primary" type="submit">新增期间</button></div></form></section>${table(["期间","状态","Revision","创建时间","操作"],rows,5)}`;
}

export function masterDataPage(items: Record<string, unknown>[], csrf: string): string {
  const rows = items.map((item) => `<tr><td>${value(item,"type")}</td><td>${value(item,"code")}</td><td>${value(item,"name")}</td><td>${status(value(item,"status"))}</td><td>${value(item,"revision")}</td><td>
    ${item.status === "ACTIVE" ? `<form method="post" action="/admin/master-data/${value(item,"type")}/${value(item,"id")}/disable"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(item,"revision")}"><button class="button danger small" type="submit">停用</button></form>` : "—"}</td></tr>`).join("");
  return pageHeader("基础资料", "供应商、银行账户、科目和费用科目白名单。") + `<section class="form-panel"><form method="post" action="/admin/master-data"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="form-grid">
    <div class="form-row"><label class="form-label" for="master-data-type">类型</label><select class="form-control" id="master-data-type" name="type"><option value="supplier">供应商</option><option value="bank-account">银行账户</option><option value="account">会计科目</option></select></div>
    <div class="form-row"><label class="form-label" for="master-data-name">名称</label><input class="form-control" id="master-data-name" name="name" required></div>
    <div class="form-row"><label class="form-label" for="master-data-code">编码（供应商/科目）</label><input class="form-control" id="master-data-code" name="code"></div>
    <div class="form-row"><label class="form-label" for="master-data-tail">账户尾号（银行）</label><input class="form-control" id="master-data-tail" name="accountTail" inputmode="numeric"></div>
    <div class="form-row full"><label><input type="checkbox" name="expenseWhitelisted" value="true"> 加入费用科目白名单</label></div></div>
    <div class="form-actions"><button class="button primary" type="submit">新增基础资料</button></div></form></section>${table(["类型","编码/尾号","名称","状态","Revision","操作"],rows,6)}`;
}

export function jobsPage(jobs: Record<string, unknown>[], csrf: string): string {
  const rows = jobs.map((job) => `<tr><td>${value(job,"id")}</td><td>${value(job,"type")}</td><td>${status(value(job,"status"))}</td><td>${value(job,"attempts")}/${value(job,"max_attempts")}</td><td>${dateValue(job.created_at)}</td><td>${dateValue(job.updated_at)}</td></tr>`).join("");
  return pageHeader("运行任务", "持久化任务、租约、重试和崩溃恢复。", `<form method="post" action="/runtime/jobs/health"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button primary" type="submit">运行健康检查</button></form>`) + table(["任务 ID","类型","状态","尝试","创建时间","更新时间"],rows,6);
}

export function auditPage(items: Record<string, unknown>[]): string {
  const rows = items.map((item) => `<tr><td>${dateValue(item.occurred_at)}</td><td>${value(item,"actor_username")}</td><td>${value(item,"action")}</td><td>${value(item,"object_type")}</td><td>${value(item,"object_id")}</td><td>${value(item,"before_revision")}</td><td>${value(item,"after_revision")}</td><td>${result(value(item,"result"))}</td></tr>`).join("");
  return pageHeader("审计日志", "只追加记录，不允许修改或删除。") + table(["时间","用户","操作","对象","对象 ID","前Revision","后Revision","结果"],rows,8);
}

export function backupsPage(backups: Record<string, unknown>[], csrf: string): string {
  const rows = backups.map((item) => `<tr><td>${dateValue(item.created_at)}</td><td>${value(item,"id")}</td><td>${value(item,"path")}</td><td>${status(value(item,"status"))}</td><td>${dateValue(item.verified_at)}</td></tr>`).join("");
  return pageHeader("备份恢复", "在线一致性备份；恢复必须通过离线CLI执行。", `<form method="post" action="/ops/backups"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button primary" type="submit">创建备份</button></form>`) + table(["时间","备份 ID","路径","状态","验证时间"],rows,5);
}

function pageHeader(title: string, description: string, action = ""): string {
  return `<div class="page-header"><div><h1 class="page-title">${escapeHtml(title)}</h1><p class="page-description">${escapeHtml(description)}</p></div>${action}</div>`;
}

function table(headers: string[], rows: string, columns: number): string {
  return `<div class="table-frame"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td class="empty-row" colspan="${columns}">暂无记录</td></tr>`}</tbody></table></div>`;
}

function status(text: string): string {
  const good = ["ACTIVE","OPEN","SUCCEEDED","VERIFIED","运行正常"].includes(text);
  const failed = ["DISABLED","CLOSED","FAILED","CANCELLED"].includes(text);
  return `<span class="${good ? "result-success" : failed ? "result-failed" : ""}"><span class="status-dot"></span>${text}</span>`;
}

function result(text: string): string { return `<span class="${text === "SUCCESS" ? "result-success" : "result-failed"}"><span class="status-dot"></span>${text}</span>`; }
