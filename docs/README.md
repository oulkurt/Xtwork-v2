# 小瞳 Work v2 文档

## 文档权威层级与单一真值源

避免同一事实在多处漂移，本仓库文档按权威顺序分工维护：

1. **`main` 分支源码与自动化测试（最高事实源）**：如文档描述与当前代码不一致，以 `main` 实建代码为准。
2. **实建说明（`docs/*.md`，As-Built）**：只记录**已合入 `main`** 的架构现状、构建/测试命令与已验证行为，不把未合并 PR 写成已上线能力。
3. **决策索引与记录（`DECISIONS.md` 与 `docs/decisions/ADR-*.md`）**：`DECISIONS.md` 是决策状态与待决策（`Q-*` / `PD-*`）的唯一总表；各篇已生效 ADR 保持历史正文不可变，演进通过头部 `Status` 与双向链接标明 `Amended` / `Superseded`。
4. **设计与验收规划（`docs/plan/*.md`，As-Designed）**：描述蓝图、接口草案与分阶段验收标准；标注【已定】【建议】【待定】【待验证】。
5. **历史归档与早期原型（非规范资料）**：[Dim 架构归档](plan/03-内置运行时-Dim.md)、[Dim ACP 未实施待办](plan/dim-acp-flavor-todo.md) 与 [2026-11-19 交互原型](../.smyw/20261119-xtwork-v2/preview.html) 仅作历史溯源，不约束现行实现。

## 当前进度

**Apple Silicon macOS Alpha 预览（`0.1.0-alpha.1` · 对账基线 `main@9d792e7`，2026-11-26）。** 已合入桌面底座、随包 Pi `1.5.2`（「小瞳」）、M1a（中文默认与内置浏览器）、M1b（硬化 SecretStore / 多协议 Proxy-Only 网关 / 企业微信公司渠道 / 19 类供应商矩阵与 `/settings/channels` UI / 活跃会话热刷新）、M1c（随包 `npm`/`npx` / 4 个 ACP 种子实例 / Install Consent Gate / Provider Provisioner / 普通模式 6 大编码 Agent 入口与确定性 Coding Agent 委派路由）、待办对话通路与插件 v2 第一阶段、独立 `im-bridge` 远程连接与侧栏镭射卡，以及领航者（Leader）控制面 Slice 1/2 与动态 Bot 头像。 [桌面底座](https://github.com/oulkurt/Xtwork-v2/pull/1) · [插件与待办](https://github.com/oulkurt/Xtwork-v2/pull/10) · [插件 v2](https://github.com/oulkurt/Xtwork-v2/pull/13) · [IM 远程连接](https://github.com/oulkurt/Xtwork-v2/pull/21) · [M1b](https://github.com/oulkurt/Xtwork-v2/pull/28) · [M1c](https://github.com/oulkurt/Xtwork-v2/pull/29) · [Leader Slice 1](https://github.com/oulkurt/Xtwork-v2/pull/25) · [Leader Slice 2](https://github.com/oulkurt/Xtwork-v2/pull/31) · [动态头像与桌面修复](https://github.com/oulkurt/Xtwork-v2/pull/34)

| 里程碑 | 已合入 `main`（As-Built） | 在途 / 还缺什么（In-Flight & Gap） |
|---|---|---|
| M0 桌面、T3、Pi | 已验证 Pi `1.5.2` 随包启动、待办创建、原对话续聊与旧 Dim Alpha 数据升级迁移。 [桌面验收](desktop-foundation.md#验收) | 桌面取消按钮与交互审批 |
| M1 通用任务桌面版 | **M1a 已合入**（[PR #19](https://github.com/oulkurt/Xtwork-v2/pull/19)、[PR #20](https://github.com/oulkurt/Xtwork-v2/pull/20)）：默认简体中文（`zh`/`en` 双语）、免项目草稿、普通模式内置浏览器与开发者功能开关。<br>**M1b 已合入**（[PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24)、[PR #28](https://github.com/oulkurt/Xtwork-v2/pull/28)）：默认助手更名「小瞳」、共享硬化 OS SecretStore、多协议 Proxy-Only 网关、OAuth 代理与登录流、企业微信 OIDC 团队渠道、19 类供应商目录与 `/settings/channels` UI、零渠道引导横幅及 Pi `1.5.2` 热刷新。<br>**M1c 已合入**（[PR #26](https://github.com/oulkurt/Xtwork-v2/pull/26)、[PR #29](https://github.com/oulkurt/Xtwork-v2/pull/29)）：随包 `npm`/`npx`、4 个 ACP 种子实例、Install Consent Gate、Provider Provisioner、普通模式 6 大编码 Agent 入口、确定性 `codingAgent` 委派路由、结构化简报守卫与 IM/群聊硬拒绝。 | 真实企业微信与 19 类线上供应商账号实跑回归；`PATH=/usr/bin:/bin` 干净机器 6 款外部 Agent 真实安装、`dsh --profile acp` 行为及打包端到端验收。 |
| M2 插件通路 | **已合入**：Go 宿主、moejs worker、MCP 工具与禁用、待办对话操作回执（`TodoActionReceipt`）/撤销/`@` 上下文（[PR #2](https://github.com/oulkurt/Xtwork-v2/pull/2)、[PR #6](https://github.com/oulkurt/Xtwork-v2/pull/6)、[PR #10](https://github.com/oulkurt/Xtwork-v2/pull/10)），`confirm: true` 宿主注册与 IM/Leader 审批队列校验（[PR #17](https://github.com/oulkurt/Xtwork-v2/pull/17)），以及**插件 v2 第一阶段**（`api: 2` 强判别清单、功能/外观双轨、`PluginModalHost`，[PR #11](https://github.com/oulkurt/Xtwork-v2/pull/11)–[PR #13](https://github.com/oulkurt/Xtwork-v2/pull/13)）。 [工具型插件](plugin-tools.md) · [插件 v2](plugin-v2.md) | 公开插件契约冻结（PD-01）、本地插件目录安装/Reload/重授权 UI、纯桌面聊天时间线内的通用 `confirm: true` 交互审批卡片。 |
| M3 内置插件 | 待办（`api: 2`）已实现创建、查询、编辑、完成、重开、删除、对话回执撤销与重启持久化。 | 待办提醒、日程插件、Obsidian 笔记插件。 [工具型插件](plugin-tools.md) · [内置插件规划](plan/06-内置插件-待办日程笔记.md) |
| M4 远程连接与领航者 | **`im-bridge` 底座与领航者（Leader）Slice 1 / Slice 2 已合入**（[PR #15](https://github.com/oulkurt/Xtwork-v2/pull/15)–[PR #18](https://github.com/oulkurt/Xtwork-v2/pull/18)、[PR #21](https://github.com/oulkurt/Xtwork-v2/pull/21)、[PR #25](https://github.com/oulkurt/Xtwork-v2/pull/25)、[PR #31](https://github.com/oulkurt/Xtwork-v2/pull/31)、[PR #34](https://github.com/oulkurt/Xtwork-v2/pull/34)）：独立 Node `im-bridge`、飞书/企微/个人微信适配器、配对与门禁、侧栏「远程连接」镭射卡、侧栏顶部固定入口、按 run 持久化 fail-closed 策略（`xtwork_run_policies`）、受众过滤 Needs You 聚合、暂停/恢复重投及 `companion/leaders/<leaderId>/` 幂等迁移；Slice 2 补齐多领航者创建与两步确认归档、IM 渠道原子换绑与断连墓碑、按受众分级的 IM 委派/进展汇报审批策略（`im_policy_json`，支持子字段并发合并）、透明沉浸式容器响应式单顶栏、侧栏「领航者 / 对话」分栏、基于 `open-bot-avatar`（MIT，23 款动态 Bot 造型 + 自由调色 + 编辑/新建区无放回随机 + WKWebView 显式尺寸/独立 SVG ID）的状态驱动领航者头像，以及移除「领航控制面」兜底文案后的 IM 绑定平台在线（绿圆）/离线（红方）指示。 [桌面预览](desktop-foundation.md#远程连接im-bridge与-leader-控制面) | 飞书/企微/个人微信三平台真机闭环、微信 iLink 合规、飞书卡片审批（Q-09）以及 [ADR-013](decisions/013-leader-supervisory-threads.md) 剩余项（外部会话扫描交接 UI、空闲 `tidy` 调度、非 Pi 远程运行时，见 Q-13）。 [远程连接规划](plan/07-远程连接插件.md) |
| M5 发布候选 | 已有 macOS arm64 打包（含 Node/`npm`/`npx`、T3、Pi、`plugin-host`、`im-bridge`）、签名更新与 R2 上传脚本。 | 正式签名公证、发布渠道、干净机器安装升级验收及 Windows 独立验收。 [发布规划](plan/09-品牌与发布.md) |

**已定方向速览**：首发模型供给（Q-03）与外部编码 Agent 可见性（Q-02）均已由 [ADR-012](decisions/012-xiaotong-model-channels-and-coding-agents.md) 定案并完成 M1b/M1c 代码合入；待确认事项唯一总表见 [Pending Decisions](../DECISIONS.md#pending-decisions)。

**验收记录**：最新自动化与原生 WKWebView 验收涵盖简体中文首启、内置浏览器、开发者开关、待办面板/对话通路、插件 v2 模态、IM 安全门禁、Leader Slice 1/2（多领航者、原子换绑/断连墓碑、动态 Bot 头像与 WKWebView 多视口几何/命中测试）、M1b（硬化 SecretStore / 多协议网关 / 企微 OIDC / 19 类供应商 / OAuth 登录流 / 模型渠道 UI）以及 M1c（ACP 种子 / Consent Gate / Provisioner / 确定性 Coding Agent 委派与 IM 硬禁）。 [桌面验收](desktop-foundation.md#验收)

## 当前运行进程

mygo 外壳管理本机 T3 Node 服务，WebView 加载服务提供的同源 React 界面。T3 的原生适配层通过 RPC 启动随包 Pi（「小瞳」）；Pi 经会话级 MCP 调用待办（经 JSONL 插件桥送到 Go 宿主和 moejs worker）、受控 IM 工具以及受 `codingAgentDelegation.ts` 守卫的 `delegate_task`。本机多协议 Proxy-Only 网关由 `runtime/channelManager.ts`、`runtime/companyAuth.ts`、`runtime/providerCatalog.ts`、`runtime/oauthLoginFlows.ts`、`runtime/oauthProxy.ts` 与硬化 `runtime/secretStore.ts` 协同驱动，并通过 `/api/xtwork/channels/*` 支撑「设置 → 模型渠道」（开发预览仍支持通过 `XTWORK_DEV_FALLBACK=1` 或 `XTWORK_MODEL_UPSTREAM_*` 激活本地 Magpie 兜底）。T3 同时以随包 Node 监管独立 `im-bridge` 子进程（未绑定时零外网连接）并通过 `XtworkLeaderStore` 与 `xtwork_run_policies` 驱动侧栏顶部固定 Leader 控制面。 [桌面外壳](../shell/main.go) · [插件宿主接入](../overlay/files/apps/server/src/mcp/XtworkPluginHost.ts) · [IM 与 Leader 桥接](../overlay/files/apps/server/src/im/XtworkImBridgeHost.ts) · [模型网关](../runtime/gateway.ts) · [模型渠道路由](../overlay/files/apps/server/src/xtwork/modelChannelsRoutes.ts) · [编码委派守卫](../overlay/files/apps/server/src/xtwork/codingAgentDelegation.ts)

## 实现说明

- [桌面预览、构建与更新](desktop-foundation.md)
- [工具型插件和待办](plugin-tools.md)
- [插件 v2 第一阶段](plugin-v2.md)
- [界面配色](ui-appearance.md)

## 设计与验收

| 主题 | 文档 |
|---|---|
| 架构和依赖 | [01 架构](plan/01-架构.md) · [02 上游与改造层](plan/02-上游与改造层.md) |
| 运行时、外壳与模型 | [03 内置运行时 · Pi](plan/03-内置运行时-Pi.md) · [04 mygo 外壳](plan/04-mygo外壳.md) · [13 模型网关](plan/13-模型网关.md) |
| 插件与通用任务 | [05 插件系统](plan/05-插件系统.md) · [06 内置插件](plan/06-内置插件-待办日程笔记.md) · [07 远程连接](plan/07-远程连接插件.md) · [08 通用任务](plan/08-通用任务化改造.md) |
| 品牌、发布与迁移 | [09 品牌与发布](plan/09-品牌与发布.md) · [12 从 xtwork 迁移](plan/12-从xtwork迁移.md) |
| 验收、风险和依据 | [10 里程碑与验收](plan/10-里程碑与验收.md) · [11 风险与待定](plan/11-风险与待定.md) · [附录 已核实事实](plan/附录-已核实事实.md) |
| 已确认方向与待决策 | [决策索引](../DECISIONS.md) · [工程决策记录](decisions/README.md) |

插件 v2 的已确认协议见 [ADR-010](decisions/010-plugin-v2-runtime.md)，基于 Mingle 渠道层与伴侣范式的 IM 远程连接服务见 [ADR-011](decisions/011-mingle-im-bridge.md)，M1 内置助手「小瞳」多渠道模型平面、六大编码 Agent 一键安装与 Coding Agent 委派架构见 [ADR-012](decisions/012-xiaotong-model-channels-and-coding-agents.md)，将远程连接统一归属到 Captain 式 Leader 主管、侧栏顶部固定入口与 Mingle 能力分级移植边界见 [ADR-013](decisions/013-leader-supervisory-threads.md)。

历史资料见 [Dim 架构](plan/03-内置运行时-Dim.md) 和 [Dim ACP 未实施待办](plan/dim-acp-flavor-todo.md)。

### 标记约定

- **【已定】** 已确认的产品方向。
- **【建议】** 可按验收结果调整的设计。
- **【待定】** 需要确认范围或方案。
- **【待验证】** 仍需运行实际应用或测试环境。

### 代码与文档约定

- **新写的代码和补丁里不要添加注释。** 需要记录的设计原因与约束写进 `docs/`；清理旧代码时保留构建和检查工具读取的指令（如 `@effect-diagnostics`）与第三方许可声明。
- 功能完成后，在 `docs/` 更新对应的实现与验证说明，同步上面的进度表，并运行 `node scripts/check-docs.mjs` 校验全仓链接、锚点、ADR 编号与补丁台账一致性。
