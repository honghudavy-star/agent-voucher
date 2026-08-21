# Agent Voucher

Agent Voucher 是本地优先的账证工作台。第一阶段基线覆盖访问与工作区（A01）以及运行与审计（A02）；当前第二阶段按正式需求实施来源接入（A03）、证据库（A04），以及受限的银行表格和文字型发票 PDF 提取。OCR、匹配、Agent、凭证和 ERP 仍不在当前范围。

当前正式需求基线见 [`docs/PRD.md`](docs/PRD.md)，对抗性审查见 [`docs/PRD-review.md`](docs/PRD-review.md)，第二阶段数据流和威胁边界见 [`ADR-0004`](docs/adr/0004-phase2-source-evidence-threat-model.md)。需求已经批准不代表实现或验收已经完成。

## 启动

需要 Node.js 24 LTS：

```bash
npx -y agent-voucher@0.1.0 start
```

本地开发：

```bash
npm install
npm run build
node dist/cli.js start --data-dir ./.local-data
```

显式局域网模式使用未加密HTTP，只能在受信、隔离的私有网络中使用：

```bash
agent-voucher start --lan
```

## 命令

- `start [--port 8765] [--data-dir PATH] [--no-open] [--lan]`
- `doctor [--data-dir PATH] [--json]`
- `backup [--data-dir PATH] [--output PATH]`
- `restore <backup> [--data-dir PATH] [--yes]`
- `completions <shell>`，shell为`bash`、`zsh`或`fish`

## 安全边界

- 单企业、单账套、单应用实例。
- 会话和密码只保存不可逆哈希。
- 飞书 App Secret 必须保存在 Windows Credential Manager，不能进入 SQLite 或备份。
- 默认只绑定 `127.0.0.1`。
- `--lan` 使用 HTTP，凭据、会话和财务原件没有传输加密；禁止端口映射或公网暴露。
- 原件和备份暂不做应用级静态加密，备份介质可直接读取财务资料。
- 真实npm发布和GitHub Release不属于本地实现授权。
