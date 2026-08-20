# Chrome Playwright DOM QA

日期：2026-08-20  
浏览器：用户现有Google Chrome，经Codex Chrome插件控制  
方法：插件内置Playwright DOM locator、DOM snapshot、只读computed-style和console log；未使用截图、OCR或坐标操作。

## 真实流程

1. 通过URL片段一次性令牌初始化工作区；
2. 管理员登录并进入工作区；
3. 创建`REVIEWER`并读回角色和状态；
4. 创建2026-08期间，再以Revision更新为`CLOSED`；
5. 创建供应商，再以Revision停用；
6. 运行`SYSTEM_HEALTH`并读回`SUCCEEDED`；
7. 创建在线备份并读回`VERIFIED`；
8. 审计页读回上述完整事件链；
9. 以`--lan`重启，验证持续HTTP风险警告；
10. Chrome保持连接时发送一次SIGINT，进程退出且实例锁释放。

## DOM与响应式结果

| 检查 | 结果 |
|---|---|
| 1440×1024页面横向溢出 | 0 |
| 390×844页面横向溢出 | 0 |
| 导航数量 | 7 |
| 无accessible name的控件 | 0 |
| 桌面侧栏 | fixed，236px |
| 移动侧栏 | static，390px |
| 移动导航 | 两列 |
| 表格小屏处理 | 容器`overflow-x:auto` |
| Chrome console error/warn | 0 |

## QA发现并修复

1. `/assets/app.js`未进入打包资产，初始化token不能从URL片段写入隐藏字段；已修复复制脚本并新增测试。
2. 管理表单label未关联控件，DOM locator和辅助技术无法命名输入；已补齐`for/id`和行内`aria-label`。
3. Chrome keep-alive连接导致SIGINT等待并遗留实例锁；已启用关闭阶段强制断开连接并新增回归测试。
