# A02 运行与审计对抗审查

日期：2026-08-20  
结论：P0=0，P1=0；第一阶段系统门禁通过。

## 财务事实与恢复

- `app.db`是业务和审计真值，`graph.db`仅保存流程checkpoint。
- 最小Graph State只含process ID、Revision、状态和错误码，并执行64KB上限。
- 备份通过SQLite Online Backup API生成，随后执行`quick_check`、`foreign_key_check`和SHA-256 Manifest校验。

## 架构与并发

- 一个写Worker和两个只读Worker；Fastify主线程不加载SQLite连接。
- WriteCoordinator有100条有界队列，Job有持久化状态、租约、重试和崩溃恢复。
- 第二实例、CLI doctor、backup与restore共用数据目录锁，不能建立第二Writer。

## 安全与恶意输入

- 审计表由SQLite触发器禁止UPDATE和DELETE。
- Worker错误不向Web返回堆栈；日志对Cookie、Authorization和Set-Cookie脱敏。
- 数据目录本身若为符号链接则拒绝；恢复在离线锁内完成，并保留恢复前数据库副本。

## 本轮发现与修复

1. CLI doctor最初可在服务运行时建立第二Writer：已纳入实例锁。
2. 优雅停机最初只停止定时器：已等待当前Job并归还本实例租约。
3. 幂等哈希最初包含时间戳和随机ID：已改由调用方提供稳定业务请求哈希。
4. 依赖扫描发现旧`@fastify/static`高危路径穿越公告：已升级到10.1.3，生产依赖审计归零。
5. 启动端口冲突最初可能遗留Worker和实例锁：已增加失败清理并以占用端口回归测试验证。
6. 双数据库恢复第二次重命名失败最初没有回滚：已增加旧app/graph双文件恢复路径。
7. Chrome保持HTTP keep-alive时，SIGINT最初会等待连接并遗留实例锁：已启用关闭阶段强制断开连接并增加回归测试。
