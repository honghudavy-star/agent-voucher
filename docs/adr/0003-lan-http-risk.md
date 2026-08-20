# ADR-0003：显式LAN HTTP模式

## Status
Accepted by user

## Context
用户选择局域网HTTP以保留一条命令启动体验，替代原计划中的LAN HTTPS。

## Decision
默认绑定localhost；只有`--lan`显式启用HTTP LAN。终端和所有已登录页面持续显示风险警告。

## Consequences
- 正面：主机无需证书配置。
- 负面：凭据和Session可能被网络监听，不能用于公网或不受信网络。
- 中性：未来加入HTTPS时必须以新ADR替代本决定。
