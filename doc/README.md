# 小瞳 Work v2 文档

## 文档权威层级与单一真值源

避免同一事实在多处漂移，本仓库文档按权威顺序分工维护：

1. **`main` 分支源码与自动化测试（最高事实源）**：如文档描述与当前代码不一致，以 `main` 实建代码为准。
2. **实建说明（`doc/*.md`，As-Built）**：只记录**已合入 `main`** 的架构现状、构建/测试命令与已验证行为，不把未合并 PR 写成已上线能力。
3. **决策索引与记录（`DECISIONS.md` 与 `doc/decisions/ADR-*.md`）**：`DECISIONS.md` 是决策状态与待决策（`Q-*` / `PD-*`）的唯一总表；各篇已生效 ADR 保持历史正文不可变，演进通过头部 `Status` 与双向链接标明 `Amended` / `Superseded`。
4. **设计与验收规划（`doc/plan/*.md`，As-Designed）**：描述蓝图、接口草案与分阶段验收标准；标注【已定】【建议】【待定】【待验证】。
5. **历史归档与早期原型（非规范资料）**：[Dim 架构归档](plan/03-内置运行时-Dim.md)、[Dim ACP 未实施待办](plan/dim-acp-flavor-todo.md) 与 [2026-11-19 交互原型](../.smyw/20261119-xtwork-v2/preview.html) 仅作历史溯源，不约束现行实现。

## 当前进度

**Apple Silicon macOS Alpha 预览（`0.1.0-alpha.1` · 对账基线 `main@73151e5`，2026-11-25）。** 已合入桌面底座、随包 Pi `1.5.2`（「小瞳」）、M1a 中文默认与内置浏览器、M1b-Gate 1（硬化 SecretStore / 多协议 Proxy-Only 网关 / OAuth 代理 / 活跃会话热刷新）、M1c-Gate 1（随包 `npm`/`npx` / 4 个 ACP 种子实例 / Install Consent Gate / Provider Provisioner 与普通模式 6 大编码 Agent 入口）、待办对话通路与插件 v2 第一阶段、独立 `im-bridge` 远程连接与侧栏镭射卡，以及 Leader 主管控制面 Slice 1；M1b-Gate 2 与 M1c-Gate 2 仍在途。 [桌面底座](https://github.com/oulkurt/Xtwork-v2/pull/1) · [插件与待办](https://github.com/oulkurt/Xtwork-v2/pull/10) · [插件 v2](https://github.com/oulkurt/Xtwork-v2/pull/13) · [IM 远程连接](https://github.com/oulkurt/Xtwork-v2/pull/21) · [M1b-Gate 1](https://github.com/oulkurt/Xtwork-v2/pull/24) · [Leader Slice 1](https://github.com/oulkurt/Xtwork-v2/pull/25) · [M1c-Gate 1](https://github.com/oulkurt/Xtwork-v2/pull/26)

| 里程碑 | 已合入 `main`（As-Built） | 在途 / 还缺什么（In-Flight & Gap） |
|---|---|---|
| M0 桌面、T3、Pi | 已验证 Pi `1.5.2` 随包启动、待办创建、原对话续聊与旧 Dim Alpha 数据升级迁移。 [桌面验收](desktop-foundation.md#验收) | 桌面取消按钮与交互审批 |
| M1 通用任务桌面版 | **M1a 已合入**（[PR #19](https://github.com/oulkurt/Xtwork-v2/pull/19)、[PR #20](https://github.com/oulkurt/Xtwork-v2/pull/20)）：默认简体中文（`zh`/`en` 双语）、免项目草稿、普通模式内置浏览器与开发者功能开关。<br>**M1b-Gate 1 已合入**（[PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24)）：默认助手更名「小瞳」、共享硬化 OS SecretStore、多协议 Proxy-Only 网关、OAuth 订阅代理与 Pi `1.5.2` 热刷新（桌面默认空渠道列表，预览需显式传 `XTWORK_DEV_FALLBACK=1` 或 `XTWORK_MODEL_UPSTREAM_*`）。<br>**M1c-Gate 1 已合入**（[PR #26](https://github.com/oulkurt/Xtwork-v2/pull/26)）：随包 `npm`/`npx` 与服务级 `hostEnvironment`、4 个 ACP 种子实例、服务端统一 Install Consent Gate、Provider Provisioner 与普通模式 `/settings/providers` 6 大编码 Agent 入口。 | 按 [ADR-012](decisions/012-xiaotong-model-channels-and-coding-agents.md) 在途推进：**M1b-Gate 2**（企业微信 OIDC 公司渠道、19 类供应商矩阵与模型渠道 UI）与 **M1c-Gate 2**（Coding Agent 委派路由、结构化交接简报与干净机器端到端实跑验收）。 |
| M2 插件通路 | **已合入**：Go 宿主、moejs worker、MCP 工具与禁用、待办对话操作回执（`TodoActionReceipt`）/撤销/`@` 上下文（[PR #2](https://github.com/oulkurt/Xtwork-v2/pull/2)、[PR #6](https://github.com/oulkurt/Xtwork-v2/pull/6)、[PR #10](https://github.com/oulkurt/Xtwork-v2/pull/10)），`confirm: true` 宿主注册与 IM/Leader 审批队列校验（[PR #17](https://github.com/oulkurt/Xtwork-v2/pull/17)），以及**插件 v2 第一阶段**（`api: 2` 强判别清单、功能/外观双轨、`PluginModalHost`，[PR #11](https://github.com/oulkurt/Xtwork-v2/pull/11)–[PR #13](https://github.com/oulkurt/Xtwork-v2/pull/13)）。 [工具型插件](plugin-tools.md) · [插件 v2](plugin-v2.md) | 公开插件契约冻结（PD-01）、本地插件目录安装/Reload/重授权 UI、纯桌面聊天时间线内的通用 `confirm: true` 交互审批卡片。 |
| M3 内置插件 | 待办（`api: 2`）已实现创建、查询、编辑、完成、重开、删除、对话回执撤销与重启持久化。 | 待办提醒、日程插件、Obsidian 笔记插件。 [工具型插件](plugin-tools.md) · [内置插件规划](plan/06-内置插件-待办日程笔记.md) |
| M4 远程连接与 Leader | **`im-bridge` 底座与 Leader Slice 1 均已合入**（[PR #15](https://github.com/oulkurt/Xtwork-v2/pull/15)–[PR #18](https://github.com/oulkurt/Xtwork-v2/pull/18)、[PR #21](https://github.com/oulkurt/Xtwork-v2/pull/21)、[PR #25](https://github.com/oulkurt/Xtwork-v2/pull/25)）：独立 Node `im-bridge`、飞书/企微/个人微信适配器、配对与门禁、侧栏「远程连接」镭射卡、侧栏顶部固定 Leader 主管入口、按 run 持久化 fail-closed 策略（`xtwork_run_policies`）、受众过滤 Needs You 聚合、暂停/恢复重投及 `companion/leaders/<leaderId>/` 幂等迁移。 [桌面预览](desktop-foundation.md#远程连接im-bridge与-leader-控制面) | 飞书/企微/个人微信三平台真机闭环、微信 iLink 合规、飞书卡片审批（Q-09）以及 [ADR-013](decisions/013-leader-supervisory-threads.md) Stage 2/3（多 Leader 创建/换绑 UI、外部会话扫描交接、`tidy` 调度，见 Q-13）。 [远程连接规划](plan/07-远程连接插件.md) |
| M5 发布候选 | 已有 macOS arm64 打包（含 Node/`npm`/`npx`、T3、Pi、`plugin-host`、`im-bridge`）、签名更新与 R2 上传脚本。 | 正式签名公证、发布渠道、干净机器安装升级验收及 Windows 独立验收。 [发布规划](plan/09-品牌与发布.md) |

**已定方向速览**：首发模型供给（Q-03）与外部编码 Agent 可见性（Q-02）均已由 [ADR-012](decisions/012-xiaotong-model-channels-and-coding-agents.md) 定案；待确认事项唯一总表见 [Pending Decisions](../DECISIONS.md#pending-decisions)。

**验收记录**：最新桌面 UI 与集成验收涵盖简体中文首启、内置浏览器、开发者开关、待办面板/对话通路、插件 v2 模态、IM 安全门禁与 Leader Slice 1（`XtworkLeaderSlice1.test.ts` + `LeaderUi.browser.test.tsx`）以及 M1b-Gate 1 硬化 SecretStore/多协议网关/Pi `1.5.2` 热刷新集成测试。 [桌面验收](desktop-foundation.md#验收)

## 当前运行进程

mygo 外壳管理本机 T3 Node 服务，WebView 加载服务提供的同源 React 界面。T3 的原生适配层通过 RPC 启动随包 Pi（「小瞳」）；Pi 经会话级 MCP 调用待办（经 JSONL 插件桥送到 Go 宿主和 moejs worker）与受控 IM 工具。本机多协议 Proxy-Only 网关（`runtime/gateway.ts` + `runtime/oauthProxy.ts` + 硬化 `runtime/secretStore.ts`）已具备多渠道协议保真转发与 OAuth 代理能力；在 M1b-Gate 2 接入渠道配置前，桌面进程默认以空渠道列表启动，传入 `XTWORK_DEV_FALLBACK=1` 或 `XTWORK_MODEL_UPSTREAM_*` 时激活本地 Magpie/自定义兜底线路。T3 同时以随包 Node 监管独立 `im-bridge` 子进程（未绑定时零外网连接）并通过 `XtworkLeaderStore` 与 `xtwork_run_policies` 驱动侧栏顶部固定 Leader 控制面。 [桌面外壳](../shell/main.go) · [插件宿主接入](../overlay/files/apps/server/src/mcp/XtworkPluginHost.ts) · [IM 与 Leader 桥接](../overlay/files/apps/server/src/im/XtworkImBridgeHost.ts) · [模型网关](../runtime/gateway.ts)

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

功能完成后，在 `doc/` 更新对应的实现与验证说明，同步上面的进度表，并运行 `node scripts/check-docs.mjs` 校验全仓链接、锚点、ADR 编号与补丁台账一致性。
