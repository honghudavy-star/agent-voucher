# 第一阶段系统门禁

## 已验证

- TypeScript严格类型、ESLint、架构依赖扫描和`git diff --check`。
- 18个自动化测试：A01/A02领域、五Session并发、CAS、幂等、不可变审计、Graph、备份恢复、启动失败清理、资产打包、可访问标签、CLI和HTTP安全。
- 本机Node 24.19.0下完成真实初始化、登录、创建复核员、执行Job、在线备份、离线恢复和doctor回读。
- 生产依赖`npm audit --omit=dev`为0项漏洞。
- 本地npm tarball能够通过全新npm缓存执行`agent-voucher --version`。
- 五用户60秒本机负载：2,915次读、146次写、0错误；读p95 3.17ms、写p95 1.79ms，结束后`quick_check`和外键检查通过。
- Codex Chrome插件内置Playwright DOM完成真实初始化、登录、A01/A02核心流程、LAN警告和双视口响应式验证；未使用截图。

## 未伪装为完成

- 默认30分钟五用户负载脚本已提供（`npm run test:load`），本轮实际运行60秒；完整30分钟仍是公开发布前门禁。
- GitHub三平台CI已配置，但尚未在远端实际运行。
- npm和GitHub Release未发布。

以上项目不构成A01/A02代码P0/P1，但在公开发布前必须补齐。
