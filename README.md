# Agent Voucher

Agent Voucher 第一阶段是一个本地优先的账证基础工作台，只实现访问与工作区（A01）以及运行与审计（A02）。它不包含连接器、OCR、匹配、Agent、凭证或CSV导出。

当前阶段的正式需求基线见 [`docs/PRD.md`](docs/PRD.md)，需求审查见 [`docs/PRD-review.md`](docs/PRD-review.md)。

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
- 默认只绑定 `127.0.0.1`。
- `--lan` 使用HTTP，凭据和会话没有传输加密；禁止端口映射或公网暴露。
- 真实npm发布和GitHub Release不属于本地实现授权。
