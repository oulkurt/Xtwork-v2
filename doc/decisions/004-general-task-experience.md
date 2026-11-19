# ADR-004 · 默认首页面向通用任务

- **Date** 2026-11-19
- **Status** Accepted
- **Evidence** Confirmed

## Context

T3 的上游界面以代码协作为主。v2 规划和交互原型把对话作为普通用户处理任务的入口。 [通用任务化规划](../plan/08-通用任务化改造.md) · [交互原型](../../.smyw/20261119-xtwork-v2/preview.html)

## Problem

普通用户需要打开桌面就能开始任务，开发者仍需能找到代码协作入口。

## Considered Alternatives

- 保留上游项目和开发功能优先的入口布局，这是 T3 的现有基线。
- 通用任务优先，开发者入口归入设置。从当前记录可以核实首页与 PR、Issues 的范围。 [侧栏守卫参考](../plan/附录-已核实事实.md#3-t3-code) · [候选入口清单](../plan/08-通用任务化改造.md#3-受开关控制的入口候选清单待定-q-02)

## Decision

默认首页面向通用任务。Pull requests 和 Issues 只从设置中的开发者功能区进入。其余入口清单由 Q-02 决定。免项目工作区的落盘与隔离策略由 PD-03 确认。 [已定的产品方向](../plan/08-通用任务化改造.md) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Consequences and Trade-offs

该决策约束首页和设置入口。开发者功能的显示状态仍需跨重启验收。共享 scratch 目录是候选，需要实测两个会话同时写文件时的行为。 [免项目对话设计](../plan/08-通用任务化改造.md#4-新对话默认免项目建议) · [桌面版验收](../plan/10-里程碑与验收.md#m1--通用任务桌面版)

## Migration Implications

保留已有项目和对话的访问路径。开始默认启用免项目对话前，明确目录位置与文件访问规则，核对新对话和已经选定项目的会话分别使用正确目录。 [免项目对话验收](../plan/08-通用任务化改造.md#8-验收)

## Related Decisions

- [ADR-001 · 桌面与服务端边界](001-desktop-architecture.md)
- [ADR-003 · 内置插件](003-bundled-plugins.md)
- [决策索引](../../DECISIONS.md)
