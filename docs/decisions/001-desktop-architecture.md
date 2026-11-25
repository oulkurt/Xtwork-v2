# ADR-001 · 保留 T3 服务端与界面，桌面壳使用 mygo

- **Date** 2026-11-18
- **Status** Accepted
- **Evidence** Confirmed

## Context

T3 已提供 React 界面、可单独运行的 Node/Effect 服务端和任务编排。桌面需要原生窗口和系统能力。规划明确批准更换外壳，保留 T3 的界面和服务端。 [外壳设计](../plan/04-mygo外壳.md) · [架构分层](../plan/01-架构.md#1-分层)

## Problem

桌面壳、任务编排和数据各自需要稳定的责任边界。服务端应能独立运行，减少更换外壳对会话或插件的影响。

## Considered Alternatives

- 沿用 T3 的 Electron 壳。它已有完整桥接和启动实现，可作接口参照。
- 用 mygo 构建系统 WebView 壳，复用 T3 的 React、Node 和任务编排。旧 xtwork 的原生界面可参考。 [上游范围](../plan/02-上游与改造层.md) · [旧版架构](../plan/01-架构.md#8-与-xtwork-架构的差异)

## Decision

采用 mygo/Go 桌面壳，负责窗口、原生集成、服务端启动监管和 `DesktopBridge`。T3 继续拥有会话、编排、持久化和工具入口，插件和运行时接入服务端。 [职责边界](../plan/04-mygo外壳.md#1-职责边界) · [v2 的起点](../plan/12-从xtwork迁移.md#v2-的起点)

## Consequences and Trade-offs

- 桌面预览使用独立 Node 和 `--bootstrap-fd 0` JSON。T3 在 loopback 提供同源页面与 `/ws` RPC，壳向受信顶层页面注入桥接，经 `/oauth/token` 交换会话 Bearer。 [壳的启动与鉴权](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/shell/backend.go) · [预加载](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/shell/preload.js) · [T3 RPC 路由](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/server/src/ws.ts#L3615-L3655)
- 原生能力由系统 WebView 和 Go 实现。预览的手写 JavaScript 桥接需要随 T3 接口升级同步核对。当前打包覆盖 Apple Silicon macOS，首发平台和后台行为由 Q-12、Q-07 确认。 [桌面制品脚本](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/scripts/build-desktop.mjs) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Migration Implications

T3 的 `userdata/statev2.sqlite` 由上游的 Effect SQL 仓储和编号迁移维护，底层是 `node:sqlite`。上游迁移包含编排事件、回执、投影与鉴权数据。升级时用用户数据副本验证上游迁移，以及同源页面、RPC 和壳桥接是否仍能配合。旧 xtwork 数据的承接见 ADR-005。 [数据路径](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/server/src/config.ts#L141-L166) · [SQLite 初始化](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/server/src/persistence/Sqlite.ts) · [迁移清单](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/server/src/persistence/Migrations.ts)

## Related Decisions

- [ADR-005 · 独立搭建 v2](005-clean-v2-start.md)
- [ADR-006 · 上游升级节奏](006-upstream-update-policy.md)
- [决策索引](../../DECISIONS.md)
