# ADR-003 · 用 moejs 提供与对话共享上下文的内置插件

- **Date** 2026-11-19
- **Status** Accepted
- **Evidence** Confirmed

## Context

待办、日程、Obsidian 与远程连接属于产品能力。旧项目已有 moejs 插件和业务样例。现有规划明示 v2 继续使用 moejs，并将待办、日程、Obsidian 纳入首发验收。 [插件规划](../05-插件系统.md) · [已确认的方向](../../README.md#已确认的方向)

## Problem

对话发起的操作和用户在面板上的管理需要访问同一份数据。工具返回应能支撑可靠的界面反馈。

## Considered Alternatives

- 复用 moejs 能力与局部代码，在 v2 服务端边界重新建立接入。
- 直接依赖整套旧宿主及 UI。旧架构可提供参考，规划明确选择独立搭建。尚无记录说明曾正式比较其他插件运行时。 [历史参考](../05-插件系统.md#2-历史参考和-v2-依赖) · [选择性复用](../12-从xtwork迁移.md#可选参考)

## Decision

使用 moejs。内置待办、日程、Obsidian 与对话共享 agent 上下文及各自的插件状态。对话中的写入反馈来自插件的实际执行结果。远程连接沿用插件方向，平台、功能和审批范围另行确认。 [内置插件行为](../06-内置插件-待办日程笔记.md) · [远程连接](../07-远程连接插件.md)

## Consequences and Trade-offs

桌面预览已接通待办创建、分页查询与持久化。日程、Obsidian、撤销、默认后台与 IM 范围仍按里程碑和 Q-04、Q-06–Q-09 决定。 [桌面预览待办](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/doc/desktop-foundation.md#待办插件) · [功能验收](../10-里程碑与验收.md) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Migration Implications

可独立复用旧 worker 或夹具。公开契约、权限和数据兼容应按 v2 的实际交付确认。旧待办和日程的历史数据导入属于 Q-05。 [旧版数据](../12-从xtwork迁移.md#用户数据)

## Related Decisions

- [ADR-002 · 默认运行时](002-default-dim-runtime.md)
- [ADR-005 · 独立搭建 v2](005-clean-v2-start.md)
- [ADR-007 · 插件契约与权限](007-plugin-contract.md)
- [决策索引](../../DECISIONS.md)
