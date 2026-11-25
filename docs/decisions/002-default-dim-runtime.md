# ADR-002 · 内置 Rust 版 Dim 作为默认助手

- **Date** 2026-11-19
- **Status** Superseded by [ADR-009](009-default-pi-runtime.md)（2026-11-20）
- **Evidence** Confirmed

## Context

项目需要可随桌面产品分发的默认助手。Dim 的 MIT Rust 发行版提供原生二进制、ACP、HTTP MCP 和提示词覆盖。规划已明确默认运行时及自有品牌要求。 [Dim 选择依据](../plan/03-内置运行时-Dim.md#2-为什么选-dim已定) · [品牌与发布](../plan/09-品牌与发布.md)

## Problem

默认助手需要复用 T3 的现有会话和工具通路，并能随产品独立升级及隔离本地状态。

## Considered Alternatives

- Rust Dim 官方发布二进制。可沿用 T3 的 ACP 接入，保留源码和许可出处。
- 上游 Pi 作为临时替补，规划在 Dim 出现阻断问题时考虑。
- Registry 中同名的旧 TypeScript 版许可和分发方式不同，规划已排除。 [Dim 发行方式和替补](../plan/03-内置运行时-Dim.md)

## Decision

随桌面应用打包固定版本的开源 Rust Dim 作为默认助手。用户界面采用自有品牌，分发保留第三方许可及归属。对外产品名和首用模型授权由 Q-01、Q-03 确认。 [已确认的方向](../../README.md#已确认的方向) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Consequences and Trade-offs

桌面预览通过 T3 ACP Local command 启动 Dim，ACP 走 stdio，插件工具走 T3 的 HTTP MCP。预览使用 alpha.25，发行资产带校验和。绑定模型目录、daemon 和环境参数是锁定版本带来的升级验收项。 [Dim 版本锁](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/runtime/dim.lock) · [ACP 接入补丁](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/overlay/patches/030-dim-default.patch)

该版的 ACP 接入仅接受单一工作区根目录。Obsidian 规划通过单独授权的插件工具读笔记。 [进程与工作区约束](../plan/03-内置运行时-Dim.md#4-进程数据与生命周期) · [笔记插件设计](../plan/06-内置插件-待办日程笔记.md#4-obsidian-笔记)

## Migration Implications

桌面预览使用独立的 `runtime/dim` home。更新 Dim 后核对会话恢复、权限确认、MCP、退出清理以及品牌提示。模型和凭据迁移受 ADR-008 的正式方案约束。 [Dim 生命周期与升级](../plan/03-内置运行时-Dim.md)

## Related Decisions

- [ADR-001 · 桌面与服务端边界](001-desktop-architecture.md)
- [ADR-005 · 独立搭建 v2](005-clean-v2-start.md)
- [ADR-008 · 正式模型网关](008-model-gateway.md)
- [决策索引](../../DECISIONS.md)
