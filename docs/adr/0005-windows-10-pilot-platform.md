# ADR-0005：Windows 10 作为正式局域网试点平台

## Status

Accepted

## Date

2026-08-20

## Context

第二阶段最初把 Windows 11 作为目标平台，但实际试点主机 `win-office` 是 Windows 10 22H2 build 19045。该主机已使用同一候选 tarball 完成 Node.js 24 隔离运行时、全新 npm 安装、启动、真实银行和发票解析、Evidence 上传、备份恢复 v2 与卸载演练。

产品是最多 5 名内部用户使用的受信局域网单机试点，不面向公网、SaaS 或多租户。Windows 11 并未提供本阶段必须依赖的产品能力，继续把它作为发布门禁只会让已完成的真实 Windows 10 验收无法形成明确结论。

## Decision

- 正式试点平台改为 Windows 10 22H2、AMD64、Node.js 24；不再要求 Windows 11。
- Windows 10 实机安装、启动、资料导入、备份恢复和卸载证据可以关闭 AC-33。
- Windows Credential Manager 仍是飞书/Lark App Secret 的目标存储；纯 SSH 网络登录没有桌面保管库会话，因此保存/读取/删除在首次桌面配置时作为运维检查补验，不阻断其他局域网试点能力。
- 若未来升级 Windows 11，只作为操作系统升级和兼容回归，不重新定义产品阶段。

## Evidence

- 候选 tarball SHA-256：`98baf421678a21b8328febfd4bcf8d7d98ed7af7926d70869db71f8bb523820a`。
- Windows 10 上银行 XLSX 解析 5 行且余额校验通过。
- Windows 10 上文字型发票 PDF 提取 10 个必填字段并通过金额校验。
- 备份恢复 v2 包含两个 Evidence 对象，恢复后数据库 Hash 与 Manifest 一致，SQLite、外键和 Graph 健康。
- 卸载后测试根目录、进程和任务均不存在，全局 Node 与 Auto_Voucher 数据未变化。

## Consequences

- 正面：试点平台与真实可维护主机一致，验收结论明确为 GO。
- 正面：不为当前阶段引入 Windows 11 升级成本。
- 负面：未来 Windows 11 升级仍需做一次兼容回归。
- 中性：LAN HTTP 和无应用级静态加密的已接受风险不因平台变化而改变。
