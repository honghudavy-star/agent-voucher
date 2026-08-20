# ADR-0001：全TypeScript本地模块化单体

## Status
Accepted

## Context
产品需要通过公开npm包以`npx`一键运行，同时保持单机、五用户、低运维和严格模块边界。

## Decision
使用Node.js 24、Fastify、TypeScript、服务端模板和HTMX。A01、A02是独立模块，应用仍为单进程部署。

## Consequences
- 正面：无需Python或Docker；一个npm包即可运行。
- 负面：后续OCR需要重新选择TypeScript可用实现或受限外部Worker。
- 中性：未来功能必须继续通过版本化Port接入。

## Alternatives Considered
- Python/FastAPI：文档生态强，但不符合纯npx运行选择。
- React SPA：状态与构建复杂度超过第一阶段需求。
