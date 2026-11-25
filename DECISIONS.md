# Engineering Decisions · Xtwork v2

这里索引当前生效的产品和技术决策。重大取舍的背景、替代方案和演变见 [ADR 目录](doc/decisions/README.md)。开发状态和验收见 [当前进度](doc/README.md#当前进度)。

## 证据范围

2026-11-19 初始化，2026-11-25 对账至 `main` 基线 `73151e5`（覆盖 PR #1–#26 与 ADR-001–ADR-013）。文档严格区分三层状态：**已合入 `main` 实建（As-Built）**、**已批准待落地/在途（Accepted / In-Flight）**与**已替代历史（Superseded）**；如代码与旧文档存在冲突，以 `main` 源码及已批准的最新 ADR 为准。历史初始化证据保留自 `f652f9c`、`488b882`、`6b0e780` 与 [PR #1](https://github.com/oulkurt/Xtwork-v2/pull/1)。 [规划首页](README.md) · [文档首页与权威层级](doc/README.md) · [上游同步讨论](t3-thread://v2/1a5417d8-ad4a-4937-a679-e9a08eb9fbca/7686181e-5c5e-488b-8440-4d5583408106)

| 证据标签 | 含义 |
| --- | --- |
| **Confirmed** | 有直接证据。明确标注批准的规划能支持 `Accepted`，代码能证实对应版本的实现。 |
| **Inferred** | 从现有行为推断的影响或意图，等待明确依据。 |
| **Unknown** | 已检查相关来源，仍缺少选择、合同或验收结论。 |

## 当前生效

| ID | 已确认的方向 | 依据 |
| --- | --- | --- |
| [ADR-001](doc/decisions/001-desktop-architecture.md) | T3 Code 的 React 界面和 Node/Effect 服务端负责交互、编排和持久化。mygo/Go 外壳负责窗口、原生集成和服务端生命周期。 | Confirmed |
| [ADR-009](doc/decisions/009-default-pi-runtime.md) | 随产品打包 Pi 作为默认助手，复用 T3 的原生 Pi 适配和会话工具桥（于 [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md) 定名「小瞳」并扩展多渠道模型平面）。 | Confirmed |
| [ADR-003](doc/decisions/003-bundled-plugins.md) | 以 moejs 提供与对话共享上下文的功能插件，待办、日程、Obsidian 进入首发验收；远程连接架构与首发范围由 [ADR-011](doc/decisions/011-mingle-im-bridge.md) 承接。 | Confirmed |
| [ADR-004](doc/decisions/004-general-task-experience.md) | 默认首页服务通用任务。Pull requests 和 Issues 的入口放在设置的开发者功能区；内置浏览器已于 [PR #20](https://github.com/oulkurt/Xtwork-v2/pull/20) 恢复至普通模式，外部编码 Provider 与 Coding Agent 委派由 [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md) 承接。 | Confirmed |
| [ADR-005](doc/decisions/005-clean-v2-start.md) | v2 取代 xtwork，独立搭建并使用独立数据目录。旧实现可作参考，旧数据导入单独决定。 | Confirmed |
| [ADR-006](doc/decisions/006-upstream-update-policy.md) | 等 T3 Code 官方稳定版发布后再评估上游升级。影响已发布版本的严重安全修复可以提前同步。 | Confirmed |
| [ADR-010](doc/decisions/010-plugin-v2-runtime.md) | 插件 v2 采用单一目录与功能/外观双轨运行时，功能视图复用 `AppRouteModal`。 | Confirmed |
| [ADR-011](doc/decisions/011-mingle-im-bridge.md) | 复用 Mingle（MIT）渠道层与状态机，在 T3 侧以独立 Node `im-bridge` 提供内置 IM 远程连接服务，首发飞书/微信/企微，第一版开放私聊与群聊 `@`，对齐 Mingle 伴侣范式并以危险工具 Owner 批准和提示词注入四层防御守住安全边界。 | Confirmed |
| [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md) | M1 桌面版采用「模型平面 + 运行时平面 + 委派路由」双平面架构：内置助手定名「小瞳」并经 Proxy-Only 保协议网关与单一硬化 OS SecretStore 接入企业微信公司渠道 + 19 类成员供应商；普通模式保留 6 大外部编码 Agent（Claude Code / Codex / Kimi Code / Qoder / Codebuddy Code / DeepSeek Harness）与服务端统一授权一键安装，并经 T3 `delegate_task` 提供 Coding Agent 委派（IM/群聊首版硬拒绝）。 | Confirmed |
| [ADR-013](doc/decisions/013-leader-supervisory-threads.md) | 以 T3 托管的一等 `Leader`（Captain 式控制面）统一绑定所有远程 IM 连接，在桌面侧栏顶部提供独立 `local_only` 固定主管入口与受众过滤的 Needs You 主动感知；执行策略在 Pi 启动前按 run 持久化并 fail-closed，目录演进为 `companion/leaders/<leaderId>/`，群分享收紧为内容快照审批，首发拒绝任意环境变量注入。 | Confirmed |

## 技术基线与契约（As-Built · `main@73151e5`）

| 边界 | 可核实的基线 | 关联 |
| --- | --- | --- |
| 构建与依赖 | **Confirmed · `main@73151e5`。** mygo `v0.10.0`、Go `1.27.3`、Node `26.13.1`（[PR #26](https://github.com/oulkurt/Xtwork-v2/pull/26) 起随包携带 `npm`/`npx` 并注入服务级 `hostEnvironment`）、T3 `3ce2145`、上游 pnpm `12.14.0`、Pi `1.5.2`、moejs `v0.1.1`、`im-bridge/`（独立锁定的 `@larksuiteoapi/node-sdk@1.76.0`、`@wecom/aibot-node-sdk@1.0.7`）。主线保存版本锁、`overlay/patches/`（18 个补丁）和 `overlay/files/`，`.build/` 是生成目录。 | [构建版本锁](upstream.lock) · [补丁台账](doc/plan/02-上游与改造层.md#4-实建补丁台账as-built) · [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-006](doc/decisions/006-upstream-update-policy.md) |
| 桌面与前后端 | **Confirmed · `main@73151e5`。** mygo 启动 loopback Node，经 `--bootstrap-fd 0` 传 JSON 并传入 `XTWORK_PI_BINARY`、`XTWORK_PLUGIN_HOST_BIN`、`XTWORK_IM_BRIDGE_ENTRY` 等绝对路径与随包 Node/npm/npx 环境。T3 服务端提供同源 Web 界面（默认简体中文、普通模式保留 `ServerBrowser`、`/settings/providers` 六大外部编码 Agent 卡片、独立侧栏「远程连接」镭射卡及顶部固定 Leader 主管入口与监管栏），React 用 T3 RPC/WebSocket `/ws`，桌面能力经 `window.desktopBridge`。 | [ADR-001](doc/decisions/001-desktop-architecture.md) · [PR #19](https://github.com/oulkurt/Xtwork-v2/pull/19) · [PR #20](https://github.com/oulkurt/Xtwork-v2/pull/20) · [PR #21](https://github.com/oulkurt/Xtwork-v2/pull/21) · [PR #25](https://github.com/oulkurt/Xtwork-v2/pull/25) · [PR #26](https://github.com/oulkurt/Xtwork-v2/pull/26) |
| 身份、安全与凭据 | **Confirmed · `main@73151e5`。** 受信顶层页面经 `/oauth/token` 把启动凭据交换为会话 Bearer；插件面板在不透明源 iframe 中经受信父页面中转。共享硬化 OS SecretStore（`im-bridge/src/platform/secrets.ts` + `runtime/secretStore.ts`，无明文回退、删除回读验证、代际栅栏）已在 PR #24 合入，服务 `app.xtwork.im-bridge` 与 `app.xtwork.model-channels`。IM 远程连接与 Leader Slice 1（PR #15–#18、#25）已合入门禁配对、按 run 持久化 fail-closed 策略（`xtwork_run_policies`）、Pi 目录外只读拦截、受众过滤 Needs You 聚合与暂停/恢复重投；M1c-Gate 1（PR #26）已合入服务端统一 Install Consent Gate 封堵运行时静默下载。 | [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-011](doc/decisions/011-mingle-im-bridge.md) · [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md) · [ADR-013](doc/decisions/013-leader-supervisory-threads.md) · [PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24) · [PR #25](https://github.com/oulkurt/Xtwork-v2/pull/25) · [PR #26](https://github.com/oulkurt/Xtwork-v2/pull/26) |
| 数据库与迁移 | **Confirmed · `main@73151e5`。** T3 拥有 `userdata/statev2.sqlite`（`node:sqlite` + Effect SQL 编号迁移）；Pi 原生会话位于 `runtime/pi/sessions`；待办持久化到 `userdata/plugins/todo/storage.json`；`im-bridge` 在 `<数据目录>/im/im.db` 保存去重、微信游标、绑定与已放行群背景（FTS5），T3 侧 `XtworkLeaderStore` 持久化 Leader / Binding / `xtwork_run_policies`，伴侣目录已于 PR #25 幂等迁移至 `<数据目录>/companion/leaders/<leaderId>/`。 | [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-005](doc/decisions/005-clean-v2-start.md) · [ADR-011](doc/decisions/011-mingle-im-bridge.md) · [ADR-013](doc/decisions/013-leader-supervisory-threads.md) |
| 助手、工具与模型 | **Confirmed · `main@73151e5`。** 默认内置助手已更名为「小瞳」（`xtworkPi`，`runtime/bundledPiSettings.ts`），经 Pi RPC 启动并通过会话 MCP 调用 `todo__*` 与受控 `im__*`。PR #24 已在 `main` 落地 M1b-Gate 1 底座（保协议多协议 Proxy-Only 网关 `runtime/gateway.ts`、OAuth 代理 `runtime/oauthProxy.ts`、Pi `1.5.2` 热刷新 `042-m1b-live-refresh.patch`；桌面当前以空渠道列表启动，预览需显式设置 `XTWORK_DEV_FALLBACK=1` 或 `XTWORK_MODEL_UPSTREAM_*` 启用 `xtwork/standard` 兜底）；PR #26 已落地 M1c-Gate 1（4 个 ACP 种子实例、Consent Gate、Provider Provisioner 与普通模式 6 大编码 Agent 入口）。企业微信 OIDC + 19 类供应商 UI（M1b-Gate 2）与 Coding Agent 委派路由（M1c-Gate 2）仍在途。 | [ADR-009](doc/decisions/009-default-pi-runtime.md) · [ADR-008](doc/decisions/008-model-gateway.md) · [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md) · [PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24) · [PR #26](https://github.com/oulkurt/Xtwork-v2/pull/26) |
| 插件与业务规则 | **Confirmed · `main@73151e5`。** 插件 v2 第一阶段已合入（PR #11–#13）：`api: 2` 强判别清单、功能/外观双轨运行时、基于 `AppRouteModal` 的 `PluginModalHost`，内置待办已迁为 `api: 2`（`kind: "functional"`）并接通对话操作回执、撤销与 `@` 上下文引用（PR #10）以及 IM 私有/群作用域隔离（PR #17）。日程、Obsidian、公开契约冻结与本地安装/Reload UI 仍按规划推进。 | [ADR-003](doc/decisions/003-bundled-plugins.md) · [ADR-007](doc/decisions/007-plugin-contract.md) · [ADR-010](doc/decisions/010-plugin-v2-runtime.md) · [工具型插件](doc/plugin-tools.md) · [插件 v2](doc/plugin-v2.md) |

实建验收记录见 [桌面预览验收](doc/desktop-foundation.md#验收)。Windows、真实供应商/IM 账号实跑、正式发布签名与完整 M1–M5 范围各有独立验收。 [里程碑](doc/plan/10-里程碑与验收.md)

## Pending Decisions

下表中的 Q 编号沿用 [产品决策清单](doc/plan/11-风险与待定.md#产品决策清单)。Q-11（[ADR-006](doc/decisions/006-upstream-update-policy.md)）、Q-04（[ADR-011](doc/decisions/011-mingle-im-bridge.md)）及 Q-02 / Q-03 / PD-02 方向（[ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md)）已有明确决定。

| ID | 需要项目负责人确认 | 证据 | 相关 ADR |
| --- | --- | --- | --- |
| Q-01 | 对外品牌名、图标、应用标识与发布源（内置助手名称已定为「小瞳」）。 | Unknown · 预览使用临时配置 | [ADR-009](doc/decisions/009-default-pi-runtime.md) · [ADR-005](doc/decisions/005-clean-v2-start.md) · [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md) |
| Q-05 | 是否导入旧数据，包含待办、日程、对话历史和授权的范围。 | Unknown | [ADR-005](doc/decisions/005-clean-v2-start.md) |
| Q-06 | 相对时间或模糊意图的自动录入、澄清和撤销规则。 | Unknown · 预览支持创建与查询 | [ADR-003](doc/decisions/003-bundled-plugins.md) |
| Q-07 | 默认是否后台运行，离线后怎样补提醒。 | Unknown · ADR-011 约定绑定 IM 后引导开启 | [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-003](doc/decisions/003-bundled-plugins.md) · [ADR-011](doc/decisions/011-mingle-im-bridge.md) |
| Q-08 | Obsidian 首发是否开放写入。 | Unknown · 读取与引用进入验收 | [ADR-003](doc/decisions/003-bundled-plugins.md) |
| Q-09 | IM 平台内卡片审批的开放范围与防重体验（危险操作必须由 Owner 批准已在 ADR-011 确认）。 | Unknown · 飞书卡片待真机验收 | [ADR-007](doc/decisions/007-plugin-contract.md) · [ADR-011](doc/decisions/011-mingle-im-bridge.md) |
| Q-10 | 第三方插件分发和插件工坊的范围、时点与信任要求。 | Unknown | [ADR-007](doc/decisions/007-plugin-contract.md) |
| Q-12 | 首发平台、架构与正式制品范围。 | Unknown · macOS arm64 有预览证据 | [ADR-001](doc/decisions/001-desktop-architecture.md) |
| Q-13 | Leader Stage 2/3 排期细节：多 Leader 复杂换绑 UI、外部会话扫描交接 UI 与非 Pi 远程运行时逐个验收时点（核心实体模型、安全契约与暂停/快照分享边界已在 ADR-013 确认）。 | Confirmed · 核心边界已定，后续交互排期待验证 | [ADR-013](doc/decisions/013-leader-supervisory-threads.md) · [ADR-011](doc/decisions/011-mingle-im-bridge.md) |
| PD-01 | 冻结 v2 插件契约、授权与存储兼容边界。 | Unknown · 公开契约尚未冻结，有预览实现 | [ADR-007](doc/decisions/007-plugin-contract.md) |
| PD-02 | 验收正式模型网关的实跑表现（方向已在 ADR-012 确认：Proxy-Only 多协议网关 + 企业微信 OIDC + 19 类供应商；M1b-Gate 1 底座与集成测试已于 [PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24) 合入 `main`，待 M1b-Gate 2 实跑验收）。 | Confirmed 方向 · Gate 1 已合入，待 Gate 2 真机验收 | [ADR-008](doc/decisions/008-model-gateway.md) · [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md) |
| PD-03 | 免项目对话的默认位置与并发隔离规则。 | Unknown · 共享 scratch 是规划候选 | [ADR-004](doc/decisions/004-general-task-experience.md) |

## 关键风险与验收缺口

- **Confirmed** · 同一 MCP 会话内重发同一创建请求已去重。重连后的新请求和模型重新发起的调用各算一次新操作。插件公开契约与升级兼容规则（PD-01）仍待冻结。 [待办去重范围](doc/plugin-tools.md#当前边界) · [ADR-007](doc/decisions/007-plugin-contract.md)
- **Confirmed** · Proxy-Only 多协议模型网关、OAuth 代理、硬化共享 OS SecretStore 与 Pi `1.5.2` 活跃会话热刷新已于 PR #24 合入 `main`（不再采用早期规划的独立 Go 网关进程）；6 大外部编码 Agent 普通模式可见、随包 `npm`/`npx`、Install Consent Gate 与 Provider Provisioner 已于 PR #26 合入 `main`；企业微信 OIDC 团队渠道、19 类供应商真实线上回归（M1b-Gate 2）及 Coding Agent 委派路由（M1c-Gate 2）与干净机器实跑仍在途待验收。 [ADR-008](doc/decisions/008-model-gateway.md) · [ADR-012](doc/decisions/012-xiaotong-model-channels-and-coding-agents.md)
- **Confirmed** · `im-bridge` 底座、三平台适配器、双层安全闸门、侧栏镭射卡与 Leader Slice 1 均已合入 `main`（PR #15–#18、#21、#25），但三平台真机闭环、微信 iLink 实名/分发合规、飞书卡片审批（Q-09）与 Leader Stage 2/3（Q-13）仍需端到端验收。 [ADR-011](doc/decisions/011-mingle-im-bridge.md) · [ADR-013](doc/decisions/013-leader-supervisory-threads.md)
- **Confirmed** · 品牌替换和 18 个上游补丁依赖固定的上游源码锚点（`t3code@3ce2145`），桌面首轮构建限 macOS arm64。Windows、正式签名公证、发布源和出站流量按目标发布范围验收。 [ADR-001](doc/decisions/001-desktop-architecture.md) · [ADR-006](doc/decisions/006-upstream-update-policy.md) · [品牌与发布](doc/plan/09-品牌与发布.md)
- **Unknown** · 第三方插件隔离、同目录并发写入（PD-03）的最终设计和运行结果。 [待验证清单](doc/plan/11-风险与待定.md#需要实跑的关键问题)

## 历史决策与已撤回的候选

| ID | 历史选择 | 现行记录 |
| --- | --- | --- |
| H-01 | **Confirmed · 旧产品架构。** 旧 xtwork 使用 mygo 原生界面、Pi sidecar、自有会话日志和壳内插件宿主。v2 采用独立起点。 | [ADR-005](doc/decisions/005-clean-v2-start.md) |
| H-02 | **Confirmed · 上游原实现。** T3 Code 的 Electron 外壳在 v2 被 mygo 替代。 | [ADR-001](doc/decisions/001-desktop-architecture.md) |
| H-03 | **Confirmed · 历史候选。** 初稿提出 Git submodule 与双周同步。预览采用可重建的浅缓存，当前同步策略改为稳定版发布后评估。 | [ADR-006](doc/decisions/006-upstream-update-policy.md) |
| H-04 | **Confirmed · 已替代。** 最初的桌面 Alpha 随包交付 Dim Agent Alpha。2026-11-20 确认切到 Pi。 | [ADR-002](doc/decisions/002-default-dim-runtime.md) · [ADR-009](doc/decisions/009-default-pi-runtime.md) |
