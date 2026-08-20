# ADR-0002：SQLite专用Worker边界

## Status
Accepted

## Context
SQLite只允许一个Writer，而Fastify不能被同步SQLite调用阻塞。

## Decision
使用`better-sqlite3`，一个写Worker持有写连接，两个只读Worker持有只读连接；所有访问使用RPC。

## Consequences
- 正面：明确单写者、隔离事件循环、便于故障注入。
- 负面：需要RPC协议和Worker生命周期管理。
- 中性：达到多实例需求时迁移PostgreSQL。

## Alternatives Considered
- `node:sqlite`：当前稳定级别仍未达到稳定API。
- 主线程同步访问：会阻塞Web请求。
