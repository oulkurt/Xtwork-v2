# ADR-006 · 跟随 T3 官方稳定版本评估升级

- **Date** 2026-11-19
- **Status** Accepted
- **Evidence** Confirmed

## Context

v2 保留上游 T3，品牌、运行时和插件桥由 overlay 适配。工作区已有的两处规划更新将 Q-11 标为【已定】。用户在 2026-11-19 的上游同步讨论中明确要求等官方稳定版再同步。初始化时两处更新仍在本地工作树。 [同步流程](../plan/02-上游与改造层.md#5-同步流程) · [Q-11 记录](../plan/11-风险与待定.md#产品决策清单) · [上游同步讨论](t3-thread://v2/1a5417d8-ad4a-4937-a679-e9a08eb9fbca/7686181e-5c5e-488b-8440-4d5583408106)

## Problem

上游更新需要控制补丁维护成本，并复核桌面、模型和插件通路。

## Considered Alternatives

- 按双周节奏同步。这是初稿候选。
- 等官方稳定版发布后再评估，严重安全修复保留提前同步的路径。 [规划初稿](https://github.com/oulkurt/Xtwork-v2/blob/f652f9c534e550c591ea2bd316596b6be6e31c9f/docs/02-上游与改造层.md#5-同步流程建议) · [现行同步流程](../plan/02-上游与改造层.md#5-同步流程)

## Decision

等官方稳定版发布后评估，选择仍包含当前所需能力的正式版。会影响已发布版本的严重安全修复可提前同步。实施时将所选提交全 SHA 写入锁文件，按既有升级流程验收。 [同步流程](../plan/02-上游与改造层.md#5-同步流程)

## Consequences and Trade-offs

- 桌面预览以 `upstream.lock` 和 overlay 重建上游树。实际使用浅缓存与生成目录，取代初稿中建议的 submodule 布局。此处记录构建现状和历史候选。 [上游锁](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/upstream.lock) · [准备脚本](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/scripts/prepare.mjs)
- 品牌替换与补丁依赖上游文本和路径。升级时从干净的生成树开始验收，避免上次复制的文件影响结果。 [补丁和同步流程](../plan/02-上游与改造层.md)

## Migration Implications

在升级工作树更新上游锁及受影响的工具链值。用新构建核对品牌、遥测、更新配置、上游数据库迁移、默认助手与待办的重启读回。升级 PR 记录 tag、SHA、补丁调整及验收结果。 [升级流程](../plan/02-上游与改造层.md#5-同步流程) · [预览验证入口](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/doc/desktop-foundation.md#待办插件)

## Related Decisions

- [ADR-001 · 桌面与服务端边界](001-desktop-architecture.md)
- [ADR-002 · 默认运行时](002-default-dim-runtime.md)
- [历史候选 H-03](../../DECISIONS.md#历史决策与已撤回的候选)
- [决策索引](../../DECISIONS.md)
