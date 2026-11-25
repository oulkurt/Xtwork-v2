# ADR-005 · 独立搭建 v2 和独立管理应用数据

- **Date** 2026-11-19
- **Status** Accepted
- **Evidence** Confirmed

## Context

旧 xtwork 曾采用 mygo 原生界面、Pi sidecar、独立 session log 和壳内插件宿主。v2 的界面、会话和编排迁入 T3，规划明确可以从干净目录和当前 mygo 起步。2026-11-19 的迁移文档将这条方向标为【已定】，并写明“按你最新的决定”。调查未找到单独的审批消息原文，因此这里把该文档记录作为批准依据，并保留来源限制。 [旧版架构](../plan/01-架构.md#8-与-xtwork-架构的差异) · [迁移规划](../plan/12-从xtwork迁移.md)

## Problem

新产品要有可独立交付的首用路径，并允许旧版用户保留原有记录和并装使用。

## Considered Alternatives

- 承接旧外壳、补丁和目录，沿用原有会话及宿主。
- 独立搭建 v2，仅复用可独立移植、许可清晰的代码或自有资产。按需求明确启用旧数据导入。 [v2 的起点与可选参考](../plan/12-从xtwork迁移.md)

## Decision

v2 独立使用应用标识和数据目录。T3 负责新会话与状态，旧项目的实现及基础设施可按边界选择性复用。旧数据是否导入、导入何种数据由 Q-05 决定。 [用户数据](../plan/12-从xtwork迁移.md#用户数据) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Consequences and Trade-offs

首轮验收可以使用干净目录，旧数据继续由旧应用访问。预览复用了部分 moejs 运行逻辑、自有图标以及旧 R2 域名的独立 v2 前缀。公开品牌和发布源由 Q-01 决定。 [桌面预览构建与发布](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/doc/desktop-foundation.md)

## Migration Implications

同一个 Obsidian vault 可在 v2 重新授权读取。旧任务、会话和授权的导入仍需批准范围及兼容规则。上游 T3 的 `state.sqlite` 到 `statev2.sqlite` 迁移适用于 T3 自有状态，与旧 Xtwork 导入分别验收。 [旧版数据切换](../plan/12-从xtwork迁移.md#切换验收) · [T3 数据库初始化](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/server/src/persistence/initializeV2Database.ts)

## Related Decisions

- [ADR-001 · 桌面与服务端边界](001-desktop-architecture.md)
- [ADR-003 · 内置插件](003-bundled-plugins.md)
- [ADR-007 · 插件契约与权限](007-plugin-contract.md)
- [决策索引](../../DECISIONS.md)
