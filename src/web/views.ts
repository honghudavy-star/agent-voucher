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
  source: '<path d="M5 5h14v14H5z"/><path d="M9 2v6M15 2v6M9 16v6M15 16v6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 14v6h16v-6"/>',
  evidence: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  warning: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 18h.01"/>',
};

const nav = [
  ["/workspace", "工作区", "workspace"],
  ["/admin/users", "用户与权限", "users"],
  ["/admin/master-data", "基础资料", "data"],
  ["/accounting-periods", "会计期间", "calendar"],
  ["/sources/feishu", "资料来源", "source"],
  ["/imports", "资料导入", "upload"],
  ["/evidence", "证据库", "evidence"],
  ["/quarantine", "隔离区", "warning"],
  ["/runtime/jobs", "运行任务", "jobs"],
  ["/audit", "审计日志", "audit"],
  ["/ops/backups", "备份恢复", "backup"],
] as const;

function layout(title: string, body: string, publicPage = false): string {
  return eta.render("layout.eta", { title, body, publicPage });
}

function publicLanWarning(lanMode: boolean): string {
  return lanMode ? `<div class="lan-warning public-lan-warning" role="alert">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 1 21h22L12 2Zm1 15h-2v2h2v-2Zm0-7h-2v5h2v-5Z"/></svg>
    <span>不安全局域网模式：当前连接未加密，仅限受信网络</span></div>` : "";
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
      <div class="sidebar-foot">A01–A05 · 本地优先</div>
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

export function setupPage(message?: string, lanMode = false, canSetup = true): string {
  return layout("初始化", `<div class="auth-shell"><div class="auth-brand"><div class="brand-name">Agent Voucher</div><div class="brand-subtitle">账证基础工作台</div></div>
    ${publicLanWarning(lanMode)}
    <section class="auth-card"><h1>初始化工作区</h1><p class="muted">创建唯一工作区、账套和首位管理员。</p>
    ${message ? `<div class="flash">${escapeHtml(message)}</div>` : ""}
    ${canSetup ? `<form method="post" action="/setup">
      <div class="form-row"><label class="form-label" for="workspaceName">工作区名称</label><input class="form-control" id="workspaceName" name="workspaceName" required maxlength="120"></div>
      <div class="form-row"><label class="form-label" for="ledgerName">账套名称</label><input class="form-control" id="ledgerName" name="ledgerName" required maxlength="120"></div>
      <div class="form-row"><label class="form-label" for="username">管理员用户名</label><input class="form-control" id="username" name="username" required minlength="3" maxlength="64" autocomplete="username"></div>
      <div class="form-row"><label class="form-label" for="displayName">显示名称</label><input class="form-control" id="displayName" name="displayName" required maxlength="80"></div>
      <div class="form-row"><label class="form-label" for="password">管理员密码</label><input class="form-control" id="password" type="password" name="password" required minlength="12" maxlength="256" autocomplete="new-password"></div>
      <div class="form-actions"><button class="button primary" type="submit">创建工作区</button></div>
    </form>` : ""}</section></div>`, true);
}

export function loginPage(nonce: string, message?: string, lanMode = false): string {
  return layout("登录", `<div class="auth-shell"><div class="auth-brand"><div class="brand-name">Agent Voucher</div><div class="brand-subtitle">账证基础工作台</div></div>
    ${publicLanWarning(lanMode)}
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
const plainText = (input: unknown, fallback = "") => typeof input === "string" || typeof input === "number" || typeof input === "boolean" ? `${input}` : fallback;

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
    ${user.status === "ACTIVE" ? `<form method="post" action="/admin/users/${value(user,"id")}/disable" data-confirm="停用后将立即撤销该用户的全部会话。确认停用？"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(user,"revision")}"><button class="button danger small" type="submit">停用</button></form>` : "—"}</td></tr>`).join("");
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
    ${item.status === "ACTIVE" ? `<form method="post" action="/admin/master-data/${value(item,"type")}/${value(item,"id")}/disable" data-confirm="停用后该基础资料将不能继续使用。确认停用？"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(item,"revision")}"><button class="button danger small" type="submit">停用</button></form>` : "—"}</td></tr>`).join("");
  return pageHeader("基础资料", "供应商、银行账户、科目和费用科目白名单。") + `<section class="form-panel"><form method="post" action="/admin/master-data"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="form-grid">
    <div class="form-row"><label class="form-label" for="master-data-type">类型</label><select class="form-control" id="master-data-type" name="type"><option value="supplier">供应商</option><option value="bank-account">银行账户</option><option value="account">会计科目</option></select></div>
    <div class="form-row"><label class="form-label" for="master-data-name">名称</label><input class="form-control" id="master-data-name" name="name" required></div>
    <div class="form-row"><label class="form-label" for="master-data-code">编码（供应商/科目）</label><input class="form-control" id="master-data-code" name="code"></div>
    <div class="form-row"><label class="form-label" for="master-data-tail">账户尾号（银行）</label><input class="form-control" id="master-data-tail" name="accountTail" inputmode="numeric"></div>
    <div class="form-row full"><label><input type="checkbox" name="expenseWhitelisted" value="true"> 加入费用科目白名单</label></div></div>
    <div class="form-actions"><button class="button primary" type="submit">新增基础资料</button></div></form></section>${table(["类型","编码/尾号","名称","状态","Revision","操作"],rows,6)}`;
}

export function jobsPage(jobs: Record<string, unknown>[], csrf: string): string {
  const rows = jobs.map((job) => `<tr><td>${value(job,"id")}</td><td>${value(job,"type")}</td><td>${status(value(job,"status"))}</td><td>${value(job,"attempts")}/${value(job,"max_attempts")}</td><td>${dateValue(job.created_at)}</td><td>${dateValue(job.updated_at)}</td><td>${["PENDING","RUNNING"].includes(plainText(job.status)) ? `<form method="post" action="/runtime/jobs/${value(job,"id")}/cancel"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button danger small" type="submit">取消</button></form>` : "—"}</td></tr>`).join("");
  return pageHeader("运行任务", "持久化任务、租约、重试和崩溃恢复。", `<form method="post" action="/runtime/jobs/health"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button primary" type="submit">运行健康检查</button></form>`) + table(["任务 ID","类型","状态","尝试","创建时间","更新时间","操作"],rows,7);
}

export function auditPage(items: Record<string, unknown>[]): string {
  const rows = items.map((item) => `<tr><td>${dateValue(item.occurred_at)}</td><td>${value(item,"actor_username")}</td><td>${value(item,"action")}</td><td>${value(item,"object_type")}</td><td>${value(item,"object_id")}</td><td>${value(item,"before_revision")}</td><td>${value(item,"after_revision")}</td><td>${result(value(item,"result"))}</td></tr>`).join("");
  return pageHeader("审计日志", "只追加记录，不允许修改或删除。") + table(["时间","用户","操作","对象","对象 ID","前Revision","后Revision","结果"],rows,8);
}

export function backupsPage(backups: Record<string, unknown>[], csrf: string): string {
  const rows = backups.map((item) => `<tr><td>${dateValue(item.created_at)}</td><td>${value(item,"id")}</td><td>${value(item,"path")}</td><td>${status(value(item,"status"))}</td><td>${dateValue(item.verified_at)}</td></tr>`).join("");
  return pageHeader("备份恢复", "在线一致性备份；恢复必须通过离线CLI执行。", `<form method="post" action="/ops/backups"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button primary" type="submit">创建备份</button></form>`) + table(["时间","备份 ID","路径","状态","验证时间"],rows,5);
}

export function importsPage(csrf: string): string {
  return pageHeader("资料导入", "原件先归档，再由受限子进程解析；单文件上限 50MB。") + `<section class="form-panel">
    <form method="post" action="/imports" enctype="multipart/form-data"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <div class="form-grid"><div class="form-row"><label class="form-label" for="evidence-kind">资料类型</label><select class="form-control" id="evidence-kind" name="kind">
        <option value="BANK_STATEMENT">银行流水（XLS/XLSX/CSV）</option><option value="INVOICE">文字型发票 PDF</option><option value="CONTRACT_FILE">合同附件</option></select></div>
      <div class="form-row"><label class="form-label" for="evidence-file">选择文件</label><input class="form-control" id="evidence-file" type="file" name="file" required></div></div>
      <div class="form-actions"><button class="button primary" type="submit">上传并归档</button></div></form></section>
    <p class="muted">LAN HTTP 和未加密备份是当前明确接受的残余风险。扫描件不会执行 OCR。</p>`;
}

export function evidenceListPage(items: Record<string, unknown>[]): string {
  const rows = items.map((item) => `<tr><td><a href="/evidence/${value(item,"id")}">${value(item,"id")}</a></td><td>${value(item,"kind")}</td><td>${status(value(item,"status"))}</td><td>${value(item,"original_name")}</td><td>${value(item,"byte_size")}</td><td><code>${value(item,"content_hash")}</code></td><td>${dateValue(item.revision_created_at)}</td></tr>`).join("");
  return pageHeader("证据库", "每次导入独立留痕；相同内容只复用物理对象。", `<a class="button primary" href="/imports">导入资料</a>`) +
    table(["Evidence ID","类型","状态","原文件名","字节","SHA-256","Revision 时间"], rows, 7);
}

export function evidenceDetailPage(item: Record<string, unknown>, revisions: Record<string, unknown>[], sources: Record<string, unknown>[]): string {
  const action = item.kind === "BANK_STATEMENT" ? `<a class="button primary" href="/imports/bank/${value(item,"id")}/mapping">配置银行映射</a>` : "";
  const revisionRows = revisions.map((revision) => `<tr><td>${value(revision,"revision_no")}</td><td>${status(value(revision,"status"))}</td><td><code>${value(revision,"content_hash")}</code></td><td>${value(revision,"source_revision")}</td><td>${dateValue(revision.created_at)}</td></tr>`).join("");
  const sourceRows = sources.map((source) => `<tr><td>${value(source,"source_kind")}</td><td>${value(source,"source_ref")}</td><td>${value(source,"source_revision")}</td><td>${dateValue(source.observed_at)}</td></tr>`).join("");
  return pageHeader("证据详情", "原件不可变；下载始终使用附件响应。", action) + `<section class="form-panel details-grid">
    <div><strong>Evidence ID</strong><div>${value(item,"id")}</div></div><div><strong>类型</strong><div>${value(item,"kind")}</div></div>
    <div><strong>状态</strong><div>${status(value(item,"status"))}</div></div><div><strong>来源</strong><div>${value(item,"source_kind")}</div></div>
    <div><strong>文件名</strong><div>${value(item,"original_name")}</div></div><div><strong>大小</strong><div>${value(item,"byte_size")}</div></div>
    <div class="full"><strong>SHA-256</strong><div><code>${value(item,"content_hash")}</code></div></div>
    <div class="full"><a class="button" href="/evidence/${value(item,"id")}/download">安全下载原件</a></div></section>
    <h2 class="section-heading">Revision 历史</h2>${table(["Revision","状态","Hash","来源Revision","时间"], revisionRows, 5)}
    <h2 class="section-heading">来源观察链</h2>${table(["来源","外部对象","外部Revision","观察时间"], sourceRows, 4)}`;
}

export function bankMappingPage(evidence: Record<string, unknown>, csrf: string): string {
  const csv = String(evidence.original_name).toLowerCase().endsWith(".csv");
  return pageHeader("银行字段映射", "映射固定目标字段；系统只建议，不自动导入。") + `<section class="form-panel"><form method="post" action="/imports/bank/${value(evidence,"id")}/preview">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="sourceKind" value="${csv ? "CSV" : "SPREADSHEET"}">
    <div class="form-grid"><div class="form-row"><label class="form-label" for="mapping-name">映射名称</label><input class="form-control" id="mapping-name" name="name" required value="${value(evidence,"original_name","")}"></div>
    ${csv ? `<div class="form-row"><label class="form-label" for="csv-encoding">编码</label><select class="form-control" id="csv-encoding" name="encoding"><option>UTF-8</option><option>GB18030</option></select></div>
    <div class="form-row"><label class="form-label" for="csv-delimiter">分隔符</label><select class="form-control" id="csv-delimiter" name="delimiter"><option value=",">逗号</option><option value="\t">Tab</option><option value=";">分号</option><option value="|">竖线</option></select></div>` : `<div class="form-row"><label class="form-label" for="sheet-name">工作表</label><input class="form-control" id="sheet-name" name="sheetName" value="Sheet1" required></div>`}
    <div class="form-row"><label class="form-label" for="header-row">表头行</label><input class="form-control" id="header-row" name="headerRow" type="number" min="1" value="1" required></div>
    <div class="form-row"><label class="form-label" for="data-start-row">数据起始行</label><input class="form-control" id="data-start-row" name="dataStartRow" type="number" min="2" value="2" required></div>
    <div class="form-row"><label class="form-label" for="source-order">源顺序</label><select class="form-control" id="source-order" name="order"><option value="ASCENDING">从旧到新</option><option value="DESCENDING">从新到旧</option></select></div>
    <div class="form-row"><label class="form-label" for="amount-mode">金额列模式</label><select class="form-control" id="amount-mode" name="amountMode"><option value="SIGNED">单一正负金额列</option><option value="DEBIT_CREDIT">借贷双列</option></select></div>
    ${["transactionDate:交易日期","amount:金额（单列）","debitAmount:借方/支出","creditAmount:贷方/收入","balance:流水余额","transactionId:交易号（可选）","currency:币种（可选）","counterpartyName:对方名称（可选）","counterpartyAccount:对方账号（可选）","summary:摘要（可选）","accountTail:本方账户尾号（可选）"].map((definition) => { const [key,label] = definition.split(":"); return `<div class="form-row"><label class="form-label" for="map-${key}">${label}</label><input class="form-control" id="map-${key}" name="${key}" ${["transactionDate","balance"].includes(key ?? "") ? "required" : ""}></div>`; }).join("")}</div>
    <div class="form-actions"><button class="button primary" type="submit">解析并预览</button></div></form></section>`;
}

export function bankPreviewPage(evidenceId: string, profile: unknown, resultData: Record<string, unknown>, csrf: string, suggestedProfile?: unknown): string {
  const validation = resultData.validation as Record<string, unknown> | undefined;
  const rows = Array.isArray(resultData.rows) ? resultData.rows as Record<string, unknown>[] : [];
  const affected = new Set(Array.isArray(validation?.affectedSourceRows) ? validation.affectedSourceRows.map(Number) : []);
  const allErrors = rows.filter((row) => affected.has(Number(row.sourceRow)) || (Array.isArray(row.issues) && row.issues.length > 0));
  const previewRows = rows.slice(0, 20).concat(rows.slice(-20), allErrors)
    .filter((row, index, all) => all.findIndex((candidate) => candidate.sourceRow === row.sourceRow) === index);
  const html = previewRows.map((row) => `<tr class="${affected.has(Number(row.sourceRow)) ? "balance-error" : ""}"><td>${value(row,"sourceRow")}</td><td>${value(row,"transactionDate")}</td><td>${value(row,"amountCents")}</td><td>${value(row,"balanceCents")}</td><td>${value(row,"counterpartyName")}</td><td>${value(row,"summary")}</td><td>${Array.isArray(row.issues) ? escapeHtml(row.issues.join(", ")) : ""}</td></tr>`).join("");
  const suggestion = suggestedProfile ? `<div class="status-strip"><strong>已找到相同表头的保存映射</strong><span>${escapeHtml(JSON.stringify(suggestedProfile))}</span></div>` : "";
  return pageHeader("银行导入预览", validation?.valid === true ? "余额校验通过。" : "余额异常：默认不导入；首错及后续受影响行红色加粗。") + suggestion +
    table(["源行","日期","金额(分)","余额(分)","对方","摘要","问题"], html, 7) +
    `<section class="form-panel"><form method="post" action="/imports/bank/${escapeHtml(evidenceId)}/commit"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <input type="hidden" name="profileJson" value="${escapeHtml(JSON.stringify(profile))}"><input type="hidden" name="headerSignature" value="${value(resultData,"headerSignature","")}">
      <label><input type="checkbox" name="force" value="true"> 余额异常时仍强制导入</label>
      <div class="form-row"><label class="form-label" for="override-reason">强制导入原因</label><input class="form-control" id="override-reason" name="overrideReason"></div>
      <div class="form-actions"><a class="button" href="/imports/bank/${escapeHtml(evidenceId)}/mapping">返回修改</a><button class="button primary" type="submit">确认保存映射并导入</button></div></form></section>`;
}

export function bankImportsPage(items: Record<string, unknown>[]): string {
  const rows = items.map((item) => `<tr><td><a href="/bank-imports/${value(item,"id")}">${value(item,"id")}</a></td><td>${value(item,"evidence_revision_id")}</td><td>${status(value(item,"status"))}</td><td>${value(item,"first_error_source_row")}</td><td>${value(item,"override_reason")}</td><td>${dateValue(item.created_at)}</td></tr>`).join("");
  return pageHeader("银行流水", "重复交易允许进入，但保留未来匹配前确认状态。") + table(["Import ID","Evidence Revision","状态","首错行","覆盖原因","创建时间"], rows, 6);
}

export function bankImportDetailPage(importRow: Record<string, unknown>, rows: Record<string, unknown>[], history: Record<string, unknown>[], csrf: string): string {
  const html = rows.map((row) => { const data = plainText(row.data_json, "{}"); return `<tr><td>${value(row,"source_row")}</td><td>${value(row,"revision")}</td><td><pre>${escapeHtml(data)}</pre></td><td>${Number(row.deleted) === 1 ? "已删除" : `<form method="post" action="/bank-transactions/${value(row,"id")}/correct"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(row,"revision")}"><textarea class="form-control" name="dataJson" required>${escapeHtml(data)}</textarea><input class="form-control" name="reason" placeholder="修正原因" required><button class="button small" type="submit">保存修订</button></form><form method="post" action="/bank-transactions/${value(row,"id")}/delete" data-confirm="只做软删除并保留历史，确认？"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${value(row,"revision")}"><input type="hidden" name="dataJson" value="${escapeHtml(data)}"><input type="hidden" name="reason" value="用户软删除"><button class="button danger small" type="submit">软删除</button></form>`}</td></tr>`; }).join("");
  const historyRows = history.map((revision) => `<tr><td>${value(revision,"source_row")}</td><td>${value(revision,"revision")}</td><td>${value(revision,"operation")}</td><td>${value(revision,"data_json")}</td><td>${value(revision,"reason")}</td><td>${value(revision,"actor_id")}</td><td>${dateValue(revision.created_at)}</td></tr>`).join("");
  return pageHeader("银行导入详情", `状态：${plainText(importRow.status)}`) + table(["源行","Revision","有效数据","操作"], html, 4) +
    `<section class="form-panel"><form method="post" action="/bank-imports/${value(importRow,"id")}/transactions"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="form-row"><label class="form-label" for="new-row-json">新增流水 JSON</label><textarea class="form-control" id="new-row-json" name="dataJson" required>{"transactionDate":"2026-08-01","amountCents":0,"balanceCents":0,"currency":"CNY","rawCells":{},"issues":[],"possibleDuplicate":false}</textarea></div><div class="form-row"><label class="form-label" for="new-row-reason">新增原因</label><input class="form-control" id="new-row-reason" name="reason" required></div><div class="form-actions"><button class="button" type="submit">新增修订流水</button></div></form></section>
    <section class="form-panel"><form method="post" action="/bank-imports/${value(importRow,"id")}/override"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="form-row"><label class="form-label" for="override">强制导入原因</label><input class="form-control" id="override" name="reason" required></div><div class="form-actions"><button class="button danger" type="submit">标记为强制导入待复核</button></div></form></section>
    <h2 class="section-heading">流水 Revision 历史</h2>${table(["源行","Revision","操作","数据","原因","操作者","时间"], historyRows, 7)}`;
}

export function invoiceExtractionsPage(items: Record<string, unknown>[]): string {
  const rows = items.map((item) => `<tr><td><a href="/invoice-extractions/${value(item,"id")}">${value(item,"id")}</a></td><td>${value(item,"evidence_revision_id")}</td><td>${status(value(item,"status"))}</td><td>${value(item,"parser_version")}</td><td>${dateValue(item.created_at)}</td></tr>`).join("");
  return pageHeader("发票提取", "只处理文字层，不验证真伪或电子签名。") + table(["Extraction ID","Evidence Revision","状态","解析器","创建时间"], rows, 5);
}

export function invoiceDetailPage(extraction: Record<string, unknown>, fields: Record<string, unknown>[], history: Record<string, unknown>[], csrf: string): string {
  const rows = fields.map((item) => `<tr><td>${value(item,"field_name")}</td><td>${value(item,"raw_text")}</td><td>${value(item,"normalized_value_json")}</td><td>${value(item,"source_page")}</td><td><form method="post" action="/invoice-extractions/${value(extraction,"id")}/fields/${value(item,"field_name")}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input class="form-control" name="normalizedValue" value="${value(item,"normalized_value_json","")}" required><input class="form-control" name="reason" placeholder="修正原因" required><button class="button small" type="submit">保存修订</button></form></td></tr>`).join("");
  const fieldNames = ["invoiceCode", "invoiceNumber", "issueDate", "buyerName", "buyerTaxId", "sellerName", "sellerTaxId", "netAmountCents", "taxAmountCents", "totalAmountCents", "currency"];
  const existingNames = new Set(fields.map((item) => plainText(item.field_name)));
  const missingFieldForms = fieldNames.filter((name) => !existingNames.has(name)).map((name) => {
    const initialValue = name === "currency" ? "CNY" : name.endsWith("Cents") ? "0" : "";
    return `<tr><td>${escapeHtml(name)}</td><td><form method="post" action="/invoice-extractions/${value(extraction,"id")}/fields/${escapeHtml(name)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input class="form-control" name="normalizedValue" value="${escapeHtml(initialValue)}" placeholder="规范值" required><input class="form-control" name="reason" placeholder="补录原因" required><button class="button small" type="submit">补录字段</button></form></td></tr>`;
  }).join("");
  const historyRows = history.map((item) => `<tr><td>${value(item,"field_name")}</td><td>${value(item,"revision")}</td><td>${value(item,"raw_text")}</td><td>${value(item,"normalized_value_json")}</td><td>${value(item,"reason")}</td><td>${value(item,"actor_id")}</td><td>${dateValue(item.created_at)}</td></tr>`).join("");
  return pageHeader("发票提取详情", `状态：${plainText(extraction.status)}`) + table(["字段","原始文本","规范值","页码","修正"], rows, 5)
    + (missingFieldForms ? `<h2 class="section-heading">缺失字段人工补录</h2><p class="page-description">补录值没有 PDF 文字层来源位置，将以人工修订留痕并重新校验发票状态。</p>${table(["字段","补录"], missingFieldForms, 2)}` : "")
    + `<h2 class="section-heading">字段 Revision 历史</h2>${table(["字段","Revision","原始文本","规范值","原因","操作者","时间"], historyRows, 7)}`;
}

export function feishuConnectionsPage(items: Record<string, unknown>[], csrf: string, availability: string, permissions: { canAdmin: boolean; canSync: boolean }): string {
  const current = items.find((item) => item.id === "feishu-default");
  const rows = items.map((item) => `<tr><td>${value(item,"display_name")}</td><td>${value(item,"platform")}</td><td>${value(item,"app_id")}</td><td>${status(value(item,"status"))}</td><td>${value(item,"approval_codes_json")}</td><td>${value(item,"daily_sync_time")}</td><td><div class="inline-actions">${permissions.canAdmin ? `<form method="post" action="/sources/feishu/${value(item,"id")}/test"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button small" type="submit">测试连接</button></form>` : ""}${permissions.canSync ? `<form method="post" action="/sources/feishu/${value(item,"id")}/sync"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button small" type="submit">手动同步</button></form>` : ""}${permissions.canAdmin && item.status === "ACTIVE" ? `<form method="post" action="/sources/feishu/${value(item,"id")}/disable" data-confirm="禁用后会取消待处理同步，确认？"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button danger small" type="submit">禁用</button></form>` : ""}</div></td></tr>`).join("");
  const expectedRevision = current ? `<input type="hidden" name="expectedRevision" value="${value(current,"revision")}">` : "";
  const adminForm = permissions.canAdmin ? `<section class="form-panel"><form method="post" action="/sources/feishu"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">${expectedRevision}<div class="form-grid">
      <div class="form-row"><label class="form-label" for="fs-display">显示名称</label><input class="form-control" id="fs-display" name="displayName" value="飞书审批" required></div>
      <div class="form-row"><label class="form-label" for="fs-platform">平台</label><select class="form-control" id="fs-platform" name="platform"><option value="FEISHU">飞书中国</option><option value="LARK">Lark 海外</option></select></div>
      <div class="form-row"><label class="form-label" for="fs-app">App ID</label><input class="form-control" id="fs-app" name="appId" required></div>
      <div class="form-row"><label class="form-label" for="fs-secret">App Secret</label><input class="form-control" id="fs-secret" type="password" name="appSecret" required autocomplete="new-password"></div>
      <div class="form-row"><label class="form-label" for="fs-codes">审批定义 Codes（逗号分隔）</label><input class="form-control" id="fs-codes" name="approvalCodes" required></div>
      <div class="form-row"><label class="form-label" for="fs-controls">合同附件控件 JSON</label><textarea class="form-control" id="fs-controls" name="attachmentControlIds">{}</textarea></div>
      <div class="form-row"><label class="form-label" for="fs-lookback">首次回溯日期</label><input class="form-control" id="fs-lookback" type="date" name="initialLookbackFrom" required></div>
      <div class="form-row"><label class="form-label" for="fs-time">每日同步时间</label><input class="form-control" id="fs-time" type="time" name="dailySyncTime" value="02:00" required></div>
      <div class="form-row"><label class="form-label" for="fs-zone">时区</label><input class="form-control" id="fs-zone" name="timeZone" value="Asia/Shanghai" required></div></div>
      <div class="form-actions"><button class="button primary" type="submit">保存飞书连接</button></div></form></section>` : "";
  return pageHeader("飞书资料来源", "每天一次并支持手动同步；只归档已通过审批。") + `<div class="status-strip"><strong>Secret Store</strong><span>${escapeHtml(availability)}</span></div>${adminForm}${table(["名称","平台","App ID","状态","审批 Codes","每日时间","操作"], rows, 7)}`;
}

export function syncRunsPage(items: Record<string, unknown>[]): string {
  const rows = items.map((item) => `<tr><td><a href="/sources/feishu/runs/${value(item,"id")}">${value(item,"id")}</a></td><td>${value(item,"trigger_type")}</td><td>${status(value(item,"status"))}</td><td>${value(item,"discovered_count")}</td><td>${value(item,"archived_count")}</td><td>${value(item,"failed_count")}</td><td>${dateValue(item.started_at)}</td><td>${dateValue(item.completed_at)}</td></tr>`).join("");
  return pageHeader("飞书同步记录", "分页、部分失败、重新认证和状态复核均留痕。") + table(["批次","触发","状态","发现","归档","失败","开始","完成"], rows, 8);
}

export function syncRunDetailPage(items: Record<string, unknown>[], attachments: Record<string, unknown>[]): string {
  const itemRows = items.map((item) => `<tr><td>${value(item,"external_id")}</td><td>${value(item,"approval_code")}</td><td>${status(value(item,"remote_status"))}</td><td>${status(value(item,"source_status"))}</td><td>${value(item,"last_error_code")}</td><td>${dateValue(item.observed_at)}</td></tr>`).join("");
  const attachmentRows = attachments.map((item) => `<tr><td>${value(item,"external_id")}</td><td>${value(item,"control_id")}</td><td>${status(value(item,"status"))}</td><td>${value(item,"evidence_revision_id")}</td><td>${value(item,"last_error_code")}</td></tr>`).join("");
  return pageHeader("飞书同步批次详情", "每个审批和附件均有明确终态。")
    + table(["实例","审批定义","远端状态","归档状态","错误码","观察时间"], itemRows, 6)
    + `<h2 class="section-heading">附件结果</h2>${table(["实例","控件","状态","Evidence Revision","错误码"], attachmentRows, 5)}`;
}

export function quarantinePage(items: Record<string, unknown>[], csrf: string): string {
  const rows = items.map((item) => `<tr><td>${value(item,"id")}</td><td>${value(item,"kind")}</td><td>${value(item,"original_name")}</td><td>${value(item,"reason")}</td><td>${value(item,"byte_size")}</td><td>${dateValue(item.expires_at)}</td><td>${status(value(item,"status"))}</td><td>${item.status === "ACTIVE" ? `<form method="post" action="/quarantine/${value(item,"id")}/purge" data-confirm="清理隔离副本后不能恢复，确认？"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button danger small" type="submit">提前清理</button></form>` : "—"}</td></tr>`).join("");
  return pageHeader("隔离区", "有效期 7 天；超限文件只保留元数据。") + table(["ID","类型","文件名","原因","字节","到期","状态","操作"], rows, 8);
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
