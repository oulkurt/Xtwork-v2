# Engineering Decisions · Xtwork v2

这里索引当前生效的产品和技术决策。重大取舍的背景、替代方案和演变见 [ADR 目录](doc/decisions/README.md)。开发状态和验收见 [当前进度](doc/README.md#当前进度)。

## 证据范围

2026-11-19 初始化。调查开始时 `main` 的基线是 `f652f9c`，包含规划和交互原型，桌面代码位于当时尚未合并的 `feat/desktop-foundation`（`488b882`）。调查期间并行工作把相同的桌面实现合并为 `6b0e780`，之后本决策文档从最新 `main` 创建独立分支提交。本文以工作区现有的【已定】记录为决策依据。Q-11 还有当天同步讨论中的用户指示作为批准来源。预览分支的行为和 PR 中报告的验收各自按固定版本引用。 [规划首页](README.md) · [桌面实现提交](https://github.com/oulkurt/Xtwork-v2/tree/6b0e7803b18cf89d75257a9874198634b0ca2a55) · [原始实现提交](https://github.com/oulkurt/Xtwork-v2/tree/488b882a6e6d24b379384b33eb6cec667574c2f5) · [PR #1](https://github.com/oulkurt/Xtwork-v2/pull/1) · [上游同步讨论](t3-thread://v2/1a5417d8-ad4a-4937-a679-e9a08eb9fbca/7686181e-5c5e-488b-8440-4d5583408106)

| 证据标签 | 含义 |
| --- | --- |
| **Confirmed** | 有直接证据。明确标注批准的规划能支持 `Accepted`，代码能证实对应版本的实现。 |
| **Inferred** | 从现有行为推断的影响或意图，等待明确依据。 |
| **Unknown** | 已检查相关来源，仍缺少选择、合同或验收结论。 |

## 当前生效

| ID | 已确认的方向 | 依据 |
| --- | --- | --- |
| [ADR-001](doc/decisions/001-desktop-architecture.md) | T3 Code 的 React 界面和 Node/Effect 服务端负责交互、编排和持久化。mygo/Go 外壳负责窗口、原生集成和服务端生命周期。 | Confirmed |
| [ADR-009](doc/decisions/009-default-pi-runtime.md) | 随产品打包 Pi 作为默认助手，复用 T3 的原生 Pi 适配和会话工具桥。 | Confirmed |
| [ADR-003](doc/decisions/003-bundled-plugins.md) | 以 moejs 提供与对话共享上下文的插件。待办、日程、Obsidian 进入首发验收。远程连接是插件方向，平台范围另定。 | Confirmed |
| [ADR-004](doc/decisions/004-general-task-experience.md) | 默认首页服务通用任务。Pull requests 和 Issues 的入口放在设置的开发者功能区。 | Confirmed |
| [ADR-005](doc/decisions/005-clean-v2-start.md) | v2 取代 xtwork，独立搭建并使用独立数据目录。旧实现可作参考，旧数据导入单独决定。 | Confirmed |
| [ADR-006](doc/decisions/006-upstream-update-policy.md) | 等 T3 Code 官方稳定版发布后再评估上游升级。影响已发布版本的严重安全修复可以提前同步。 | Confirmed |

## 技术基线与契约

| 边界 | 可核实的基线 | 关联 |
| --- | --- | --- |
| 构建与依赖 | **Confirmed · 桌面预览实现。** mygo `v0.10.0`、Go `1.27.3`、Node `26.13.1`、T3 `3ce2145`、上游 pnpm `12.14.0`、Pi `1.5.2`、moejs `v0.1.1`。主线保存版本锁和 overlay，`.build/` 是生成目录。 | [构建版本锁](upstream.lock) · [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-006](doc/decisions/006-upstream-update-policy.md) |
| 桌面与前后端 | **Confirmed · 源码实现。** mygo 启动 loopback Node，经 `--bootstrap-fd 0` 传 JSON。T3 服务端提供同源 Web 界面，React 用 T3 RPC/WebSocket `/ws`，桌面能力经 `window.desktopBridge`。完整桌面链路的运行结果来自 PR 说明，调查时没有重跑。 | [ADR-001](doc/decisions/001-desktop-architecture.md) · [PR #1](https://github.com/oulkurt/Xtwork-v2/pull/1) |
| 身份与权限 | **Confirmed · 源码实现。** 受信顶层页面的桌面桥接经 `/oauth/token` 把启动凭据交换为会话 Bearer。T3 鉴权沿用锁定上游，插件面板通过受信父页面调用服务。产品账号、IM 绑定和第三方分发边界仍待定。 | [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-007](doc/decisions/007-plugin-contract.md) · [ADR-008](doc/decisions/008-model-gateway.md) |
| 数据库与迁移 | **Confirmed · 锁定上游及桌面预览。** T3 拥有 `userdata/statev2.sqlite`，使用 `node:sqlite`、Effect SQL 和编号 SQL 迁移，保存编排事件、回执、投影和鉴权状态。Xtwork 预览没有另设 ORM 或数据库迁移。Pi 的原生会话保存在应用私有目录 `runtime/pi/sessions`，待办由 Go 宿主持久化到 `userdata/plugins/todo/storage.json`。 | [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-005](doc/decisions/005-clean-v2-start.md) · [ADR-007](doc/decisions/007-plugin-contract.md) |
| 助手、工具与模型 | **Confirmed · 源码实现。** T3 经 Pi RPC 启动内置助手。Pi 经会话 MCP 调用 `todo__create`、`todo__list`，经本机网关的 Chat Completions 路由请求流式模型。预览只配置 `standard`，`deep` 待验证。 | [ADR-009](doc/decisions/009-default-pi-runtime.md) · [ADR-007](doc/decisions/007-plugin-contract.md) · [ADR-008](doc/decisions/008-model-gateway.md) |
| 插件与业务规则 | **Confirmed · 产品方向及源码实现。** 对话和面板使用同一份待办。预览支持创建、查询、编辑、完成、重开和删除，采用 `api: 1` manifest、JSONL 和受鉴权的 `/api/xtwork/todo` 接口。撤销、模糊输入处理、日程与笔记权限仍按规划验收。 | [ADR-003](doc/decisions/003-bundled-plugins.md) · [ADR-007](doc/decisions/007-plugin-contract.md) · [工具型插件](doc/plugin-tools.md) |

Pi 的桌面预览结果记录在实现说明。Windows、正式模型授权与完整 M1–M5 范围各有独立验收。 [桌面预览验收](doc/desktop-foundation.md#验收) · [里程碑](doc/plan/10-里程碑与验收.md)

## Pending Decisions

下表中的 Q 编号沿用 [产品决策清单](doc/plan/11-风险与待定.md#产品决策清单)。Q-11 已有明确决定，见 [ADR-006](doc/decisions/006-upstream-update-policy.md)。

| ID | 需要项目负责人确认 | 证据 | 相关 ADR |
| --- | --- | --- | --- |
| Q-01 | 对外品牌名、图标、应用标识与发布源。 | Unknown · 预览使用临时配置 | [ADR-009](doc/decisions/009-default-pi-runtime.md) · [ADR-005](doc/decisions/005-clean-v2-start.md) |
| Q-02 | 除 PR 和 Issues 之外，哪些入口归入开发者功能。 | Unknown | [ADR-004](doc/decisions/004-general-task-experience.md) |
| Q-03 | 首发模型由产品提供还是自带 Key，以及账号、凭据和模型数据留存边界。 | Unknown · 两条路径已有设计 | [ADR-008](doc/decisions/008-model-gateway.md) |
| Q-04 | 首个 IM 平台与开放范围，包含绑定和文本闭环。 | Unknown · 飞书是候选 | [ADR-003](doc/decisions/003-bundled-plugins.md) · [ADR-007](doc/decisions/007-plugin-contract.md) |
| Q-05 | 是否导入旧数据，包含待办、日程、对话历史和授权的范围。 | Unknown | [ADR-005](doc/decisions/005-clean-v2-start.md) |
| Q-06 | 相对时间或模糊意图的自动录入、澄清和撤销规则。 | Unknown · 预览支持创建与查询 | [ADR-003](doc/decisions/003-bundled-plugins.md) |
| Q-07 | 默认是否后台运行，离线后怎样补提醒。 | Unknown | [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-003](doc/decisions/003-bundled-plugins.md) |
| Q-08 | Obsidian 首发是否开放写入。 | Unknown · 读取与引用进入验收 | [ADR-003](doc/decisions/003-bundled-plugins.md) |
| Q-09 | 是否从 IM 审批，以及可审批的动作范围。 | Unknown | [ADR-007](doc/decisions/007-plugin-contract.md) |
| Q-10 | 第三方插件分发和插件工坊的范围、时点与信任要求。 | Unknown | [ADR-007](doc/decisions/007-plugin-contract.md) |
| Q-12 | 首发平台、架构与正式制品范围。 | Unknown · macOS arm64 有预览证据 | [ADR-001](doc/decisions/001-desktop-architecture.md) |
| PD-01 | 冻结 v2 插件契约、授权与存储兼容边界。 | Unknown · 公开契约尚未冻结，有预览实现 | [ADR-007](doc/decisions/007-plugin-contract.md) |
| PD-02 | 批准正式模型网关的部署、凭据和模型切换契约。 | Unknown · 有规划和不同形态的预览实现 | [ADR-008](doc/decisions/008-model-gateway.md) |
| PD-03 | 免项目对话的默认位置与并发隔离规则。 | Unknown · 共享 scratch 是规划候选 | [ADR-004](doc/decisions/004-general-task-experience.md) |

## 关键风险与验收缺口

- **Confirmed** · 同一 MCP 会话内重发同一创建请求已去重。重连后的新请求和模型重新发起的调用各算一次新操作。插件状态升级规则与通用契约仍待确认。 [待办去重范围](doc/plugin-tools.md#当前边界) · [ADR-007](doc/decisions/007-plugin-contract.md)
- **Confirmed** · 预览网关位于 Node 服务端进程，正式自带 Key 方案规划为独立 Go 进程。Pi 由原生适配器发现模型，预览单模型路由已接入。首用授权、凭据轮换及多模型均需按正式方案验收。 [ADR-008](doc/decisions/008-model-gateway.md)
- **Confirmed** · 品牌替换和补丁依赖固定的上游源码锚点，桌面首轮构建限 macOS arm64。Windows、正式签名公证、发布源和出站流量按目标发布范围验收。 [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-006](doc/decisions/006-upstream-update-policy.md) · [品牌与发布](doc/plan/09-品牌与发布.md)
- **Unknown** · 第三方插件隔离、IM 去重与解绑、同目录并发写入的最终设计和运行结果。 [待验证清单](doc/plan/11-风险与待定.md#需要实跑的关键问题)

## 历史决策与已撤回的候选

| ID | 历史选择 | 现行记录 |
| --- | --- | --- |
| H-01 | **Confirmed · 旧产品架构。** 旧 xtwork 使用 mygo 原生界面、Pi sidecar、自有会话日志和壳内插件宿主。v2 采用独立起点。 | [ADR-005](doc/decisions/005-clean-v2-start.md) |
| H-02 | **Confirmed · 上游原实现。** T3 Code 的 Electron 外壳在 v2 被 mygo 替代。 | [ADR-001](doc/decisions/001-desktop-architecture.md) |
| H-03 | **Confirmed · 历史候选。** 初稿提出 Git submodule 与双周同步。预览采用可重建的浅缓存，当前同步策略改为稳定版发布后评估。 | [ADR-006](doc/decisions/006-upstream-update-policy.md) |
| H-04 | **Confirmed · 已替代。** 最初的桌面 Alpha 随包交付 Dim Agent Alpha。2026-11-20 确认切到 Pi。 | [ADR-002](doc/decisions/002-default-dim-runtime.md) · [ADR-009](doc/decisions/009-default-pi-runtime.md) |
