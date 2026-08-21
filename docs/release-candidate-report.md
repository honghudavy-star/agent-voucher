# Agent Voucher 第二阶段候选验收报告

日期：2026-08-20  
候选版本：`0.1.0`  
候选 tarball SHA-256：`98baf421678a21b8328febfd4bcf8d7d98ed7af7926d70869db71f8bb523820a`  
候选来源：当前本地未提交工作树生成的不可变 npm tarball

## 结论

**GO：第二阶段可以进入 Windows 10 22H2 局域网试点。** `win-office` 已完成安装、启动、真实资料、Evidence、备份恢复和卸载验证。纯 SSH 登录没有桌面 Credential Manager 保管库会话，因此凭据保存/读取需在首次桌面配置时补验，但不阻断局域网试点。

## 已通过

- Node.js 24.19.0 下 TypeScript、ESLint、19 个测试文件、76 项测试、架构检查和构建通过。
- Windows 使用隔离的官方 Node.js 24.19.0 便携运行时完成全新 npm 安装；全局 Node.js 22 未被替换。
- Windows 原生 `better-sqlite3` 安装成功；旧版嵌套 ABI 依赖已通过构建期打包移除。
- Windows `doctor`：SQLite quick check、外键、Graph 和 11 个模块迁移通过。
- 用户银行 XLSX：SHA-256 `66c061c76ceb7775683b8eb5114d9e25dbb26a296750ec187241ca913622ddb8`；Windows 解析 5 行，余额校验通过。
- 用户文字型发票 PDF：SHA-256 `d7bce9dede25a7a2bce69424248ca0fd576b96f9ac16269bd232c31b12b41b5a`；Windows 受限子进程提取 10 个必填字段，金额校验通过，状态 `VALIDATED`。
- Windows Web 启动、初始化、登录、两份原件流式上传和 Evidence 列表回读通过。
- 备份恢复 v2：Manifest 最后发布；包含 2 个 Evidence 对象；恢复前后数据库不同；恢复后数据库 Hash 与 Manifest 一致；恢复后 doctor 通过；DB、Graph 和 Evidence 的恢复前副本均存在。
- Auto_Voucher 的 Lark App ID、App Secret 和两个审批定义已只读确认，Secret 未输出；两个开放平台域名均能签发 Token，但审批定义只存在于 `open.larksuite.com`。
- 真实 Lark Adapter：连接通过，第一页发现 20 个已通过实例，递归附件控件映射生效，签名 Lark CDN 附件流式下载首块成功；Tenant Token 不发送给 CDN。

## 实施中发现并修复

- PDF.js 在 Permission Model 下缺少 `DOMMatrix` 和 fake worker：改为纯 JavaScript DOMMatrix，并把 PDF worker 打入解析子进程。
- 标准电子发票左右栏买卖方名称、税号提取失败：支持同一文本行的按次序字段定位。
- `@langchain/langgraph-checkpoint-sqlite` 安装旧版 `better-sqlite3` 导致 Windows Node 24 安装失败：checkpoint 适配器改为构建期打入 Graph worker，运行时统一 v13。
- 固定 `open.feishu.cn`、错误的实例查询接口和顶层附件遍历无法处理实际 Lark 数据：增加飞书/Lark平台选择，采用 POST query 响应，并递归处理附件控件及受限 CDN。

## 非阻断运维检查与残余风险

- `win-office` 为 Windows 10 22H2 build 19045，与当前正式试点平台一致。
- Windows Credential Manager 在没有桌面登录用户的纯 SSH 网络登录中返回 1312；最终候选没有引入计划任务、S4U 或额外凭据编排。需用户登录 Windows 桌面后补做应用内保存、读取、删除和恢复缺失测试。
- 未执行公开发布、Git commit 或 push。
- LAN HTTP 和无应用级静态加密仍是用户已接受但未消除的风险。

## Verdict

**GO：Windows 10 局域网试点通过。桌面 Credential Manager 留作首次部署运维检查。**
