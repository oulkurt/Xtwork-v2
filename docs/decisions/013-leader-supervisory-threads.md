# ADR-013 · Leader（Captain 式主管实体）、侧栏置顶入口与 Mingle 能力移植边界

- **Date** 2026-11-25
- **Status** Accepted（Slice 1 已于 [PR #25](https://github.com/oulkurt/Xtwork-v2/pull/25) 合入 `main`；Slice 2 与「领航者 / 对话」界面重构已完成实现与验证；Stage 3 按排期推进）
- **Evidence** Confirmed · 2026-11-25 项目负责人批准方向并指示在 GPT-6.2 Astra 与 Claude Opus 5.5 达成一致后直接推进；经 Gemini 4 Neon、GPT-6.2 Astra（两轮）与 Claude Opus 5.5 核对锁定源码（`t3code@3ce2145`、`im-bridge`、`034-im-bridge.patch`、`035-pi-im-security-hook.patch`）后全面达成一致（`CONSENSUS: AGREED`）

## Context

[ADR-011](011-mingle-im-bridge.md) 已确立以 `im-bridge` 复用 Mingle（MIT）渠道层与状态机，在 T3 侧承接飞书、个人微信（iLink）和企业微信的远程连接，并在代码层落实回合级可信上下文（`TurnExecutionContext`）、受众会话隔离和四层提示词注入防御。

随着远程连接升级为独立设置边栏与镭射卡片入口（[PR #21](https://github.com/oulkurt/Xtwork-v2/pull/21)），产品进一步确立三项演进目标：

1. **以「Leader」取代「Agent」作为一等长期身份**，参考 [Capy Captains](https://capy.ai/features/captains) 的主管（Captain）控制面范式：在桌面侧栏普通对话列表上方设置独立的固定主管入口，统一承接委派任务、进度总览与「需要你决定（Needs You）」升级提醒。
2. **所有远程连接统一绑定到 Leader**：每条已激活的 IM 连接归属一个 Leader，同一个 Leader 可挂载多条 IM 渠道（飞书、企业微信、个人微信等），让用户在桌面与各聊天软件面对同一位助手身份，同时保持后台多任务隔离并发。
3. **按安全与架构边界分级移植 Mingle 能力**：复用名字/头像/角色与模板、多渠道绑定、受控上下文交接、暂停/重置会话、每日记忆整理（`tidy`）与脱敏诊断，同时修补 Mingle 原版在串聊泄露、任意环境变量注入和无隔离运行上的缺口。

核对锁定源码证实了以下关键基线与现有缺口：

- **可复用底座**：T3 已有原子事务快照 `ProjectionStore.getAgentAwarenessSnapshot()` 与 `projectThreadAwarenessV2`（含运行态、等待审批、后台子任务与 `snapshotSequence`）、`t3_thread_transfer`（fork / merge-back）以及 `AgentSessionScanner.ts`（只读扫描解析 Claude/Codex/Pi 会话）；
- **不能直接照搬的现有行为**：
  1. `Sidebar.tsx` 的普通 `pinnedThreads` 会受项目筛选过滤且可被取消置顶或归档，不能仅靠设置 `pinnedAt` 实现顶部固定主管入口；
  2. `ImApprovals` 独立存在内存 `Map` 中，未进入 T3 的 `pendingRuntimeRequest` 投影；
  3. `034-im-bridge.patch` 与 `035-pi-im-security-hook.patch` 当前依赖 `xtwork-im-` 线程前缀与“线程最后一个活跃 run”推导权限，新 Leader 派生线程、定时任务或无前缀群回复会绕过或缺少策略；
  4. `im-bridge/src/bridge.ts` 当前连接暂停会把 `received`/`delivered`/`waiting` 变成终态 `ignored` 且不通知正在运行的 T3 run；
  5. `im-bridge/src/store/store.ts` 尚无 `leaderId` / `bindingId`，且 `chats.thread_id` 为单值，换绑后不能直接复用旧 Provider 会话；
  6. `ClaudeAdapterV2.ts` 与 `CodexAdapterV2.ts` 尚无与随包 Pi 等价的隔离目录路径闸门与单次审批边界；`instanceEnvironment.ts` 直接合并覆盖进程变量，不存在安全分类器。

## Problem

如何把「Leader（Captain 式主管控制面）+ 侧栏顶部固定入口 + 远程连接归属 Leader + Mingle 生命周期能力」自然长在 T3 编排内核与 [ADR-011](011-mingle-im-bridge.md) 之上，同时彻底消除：

1. **混淆代理人（Confused Deputy）与串聊泄露**：防止群聊 `@Leader` 通过跨会话感知或猜线程 ID 读出桌面私有对话、其他群历史或 Owner 私有待办；
2. **前缀依赖与策略竞态**：防止非 `xtwork-im-` 前缀的派生线程、委派子任务或定时触发在 Pi 启动前缺少或错配执行策略；
3. **任意环境变量泄露与配置污染**：防止通用环境变量注入篡改运行时行为（如 `NODE_OPTIONS` / `PATH` / `BASH_ENV`）或把密钥带入模型、子任务与诊断日志；
4. **单会话上下文膨胀与换绑/暂停语义冲突**：保证 Leader 身份长期存在而模型上下文有界，同时确保多 Leader 换绑不重放旧消息、暂停不静默丢消息。

## Considered Alternatives

| 方案 | 概要 | 结论 |
|---|---|---|
| **方案 A：原样搬入 Mingle Agent 模型，单条置顶线程承接桌面与全部 IM 对话** | 单会话混用桌面与各群/私聊，开放全局线程读取与任意环境变量 | **拒绝。** 直接破坏 [ADR-011](011-mingle-im-bridge.md) 受众隔离与 L4 凭据边界，引发混淆代理人与上下文膨胀。 |
| **方案 B（采用）：Control Plane / Data Plane 分离 + 按 Run 持久化 Fail-Closed 策略的 Leader 架构** | T3 持有可多实例化的 `leaderId` 与侧栏顶部独立 `local_only` 主管入口（控制面）；每项具体任务与每个聊天/话题仍在受众隔离的 Worker Thread（数据面）执行；跨会话感知复用 `getAgentAwarenessSnapshot()` + `ImApprovals` 经统一服务端策略前置过滤；执行策略在 Pi 启动前按 run 持久化并 fail-closed；Mingle 能力按共识分级移植 | **采用。** 兼得 Capy Captains 主动统筹体验与 Mingle 伴侣管理，且完整守住并加固 [ADR-001](001-desktop-architecture.md)、[ADR-004](004-general-task-experience.md)、[ADR-009](009-default-pi-runtime.md)、[ADR-011](011-mingle-im-bridge.md) 不变量。 |
| **方案 C：仅保留单伴侣渠道设置页，不引入 Leader 控制面** | IM 线程平铺在侧栏，无统一身份、无跨任务 Needs You 与交接/整理/重置生命周期 | **拒绝。** 无法承接多渠道统一助手与跨任务协调的核心产品定位。 |

## Decision

以下条款经 Gemini 4 Neon、GPT-6.2 Astra 与 Claude Opus 5.5 达成一致（`CONSENSUS: AGREED`），正式生效：

### 1. Leader 一等身份、多实例 Schema 与控制面/数据面分离

1. **身份归 T3，收发归 `im-bridge`**：
   - T3 服务端持久化多实例 `Leader` 实体（`leaderId`、`name`、`avatar`、`role`、`status`、`pinnedThreadId`、`awarenessScope`）与连接归属绑定（`bindingId`、`leaderId`、`connectionId`、`epoch`、`active`）。
   - 系统默认预置 1 个可改名、可换头像的默认 Leader；Slice 1 先以单默认 Leader 跑通完整垂直闭环，Stage 2 开放简单「新建 Leader」创建入口；删除先做归档，复杂换绑 UI 延后。
   - **历史归属不可追溯修改**：每条已激活 IM 连接归属且仅归属 1 个 Leader，一个 Leader 可挂多条连接；入站投递落盘时固化 `leaderId + bindingId + bindingEpoch`，保留现有 `im:<connectionId>:<platformMsgId>` 幂等键，崩溃补投沿用首次受理的归属；换绑仅影响新消息且**绝不复用旧绑定对应的 Provider 会话或旧 `chats.thread_id`**。
2. **侧栏顶部独立固定入口（Control Plane）vs. 独立任务线程（Data Plane）**：
   - 桌面侧栏普通列表上方渲染独立的 **Leader 固定槽位**，不受项目文件夹筛选影响，也不可被误取消置顶或误归档；点击进入该 Leader 固定的 `local_only` 桌面主管线程。
   - 实际私聊、群 `@`、话题跟进及派发任务继续运行在各自受众隔离的 T3 Worker Thread 与独立工作目录中；未 `@` 的已放行群背景继续留在 `im-bridge` 缓存，不建线程、不调模型。

### 2. 按 Run 持久化的 Fail-Closed 执行策略（废除前缀猜权限）

1. **Pi 启动前必须确定并落库本次 Run 的策略**：
   - 新增服务端 `xtwork_run_policies` 持久化表，在派发创建 run 之前（而非提交后回查）原子写入 `{ runId / commandId, threadId, leaderId, bindingId, bindingEpoch, source, connectionId, chatId, chatKind, senderRole, replyAudience, companionScope, isolatedWorkspaceRoot }`。
   - `McpHttpServer`、`Orchestrator` 及 `035-pi-im-security-hook.patch` 统一改为按可信服务端持久化策略裁决，不再以 `xtwork-im-` 线程前缀或“最后一个活跃 run”作为唯一权限依据。
   - **Fail-Closed 与会话边界**：受保护线程/委派任务/定时触发若找不到对应执行策略，**直接拒绝执行**；恢复或续聊时按原 `runId` 校验策略；同一线程若新 run 策略与在运行 Pi 会话不一致，**强制新开 Pi 会话**。
   - 委派子任务（`delegate_task`）与定时任务仅允许**继承或收窄**原请求的执行策略（受众、数据作用域与回复目的地），不得提权。

### 3. 跨会话主动感知与统一 Needs You（复用 `getAgentAwarenessSnapshot` + 聚合 `ImApprovals`）

1. **主动桌面感知 + 按需钻取**：
   - 扩展 T3 现有 `ProjectionStore.getAgentAwarenessSnapshot()` 与 `projectThreadAwarenessV2`，在桌面 Leader 设置中支持 Owner **一次授权**“全部本机 T3 任务”或“指定项目”的状态感知（授权集合独立于 `leaderId` 存储，避免同一 Leader 自动等价于数据读取权），自动展示各任务阶段（进行中 / 等你决定 / 已完成 / 失败）；完整对话全文按需钻取，且观察接口**零“已读/已送达”副作用**（不直接拿 `t3_thread_read` 当后台轮询接口）。
2. **统一服务端访问策略与 Needs You 权限分离**：
   - 新增统一服务端访问策略，显式区分 `status_read`、`history_read`、`send/delegate`、`share` 四类能力，并在查询、计数、分页与摘要取片段**之前**按调用方 `TurnExecutionContext` 过滤（标题、阻塞原因与数量均视为潜在敏感信息；猜到线程 ID 也绝不放行）。
   - **Needs You 聚合 `pendingRuntimeRequest` 与 `ImApprovals`**：`status_read` 仅返回授权范围内的状态与待审批数量，**不暴露原始工具参数 `details`，也不授予审批权**；Owner 在桌面点击批准时，服务端重新核验调用者桌面权限、原 `runId` 与目标受众；服务重启后旧内存审批自动失效，重试时重新发起申请。
3. **各受众跨会话默认边界**：
   - **桌面 `local_only` 主管**：按 Owner 授权范围主动查看状态与 Needs You；
   - **Owner 私聊（`owner_dm`）**：默认可看本 Leader 自己的远程任务；读取桌面 `local_only` 会话默认**关闭**，后续按项目/线程显式授权（区分状态只读与全文读取，可随时撤销），绝不扩散到群；
   - **群聊（`group`）**：仅可见本群授权任务，在上述统一策略与按 run 透传完全落地前，继续封锁远程 `t3_thread_*`。

### 4. Mingle 能力分级移植与安全契约

| Mingle 功能 | 最终共识裁决 | 落地契约 |
|---|---|---|
| 名字、头像、角色、6 类模板 | **直接采纳** | 复用 `companion/leaders/<leaderId>/ROLE.md`；模板为可编辑预填；保存时明确提示“所有已连接聊天共享公开角色，私人背景写私有记忆”。 |
| 多渠道绑定与并发多任务 | **复用现有底座** | 沿用独立「设置 → 远程连接」镭射卡与配对认领机；每条连接归属 1 个 Leader；并发由 T3 多 Thread 承担。 |
| 群共享私有记忆（收紧 ADR-011 §4） | **按条快照审批分享** | 首版取消“按群开启全部私聊记忆”开关，仅支持 Owner 按条（可一次多选）显式审批分享；审批必须绑定 **具体内容快照 + 内容哈希 + 目标群** 并复制到群作用域，绝不授予该群持续读取 `private/` 的权限。 |
| Brain（主机 / Harness / 模型） | **桌面与远程解耦** | **桌面 `local_only` 主管 Brain**在开发者模式下可直接复用 T3 实际探测到的 Provider/模型（不照搬未接入的 Devin/Droid）；**受执行策略约束的 Worker / 远程 IM Brain** 首发强制走补齐按 run fail-closed 策略的随包 Pi；Claude Code / Codex 等非 Pi 适配器未补齐同级目录隔离与单次审批钩子前禁止承接远程/受保护任务。 |
| 环境变量（任意 Key-Value） | **首发拒绝任意注入** | 拒绝“标记非敏感即可任意注入”（`NODE_OPTIONS`/`BASH_ENV`/`PATH`/代理变量均会改变代码加载与数据流）；未来集成采用**公开具名、类型校验的配置项 + 操作系统钥匙串引用**，仅在受控集成进程启动时按白名单注入，绝不继承给模型、shell、子任务或诊断包；开发者本地 CLI 环境配置与远程任务完全隔离。 |
| 暂停 Leader | **现在定案** | 暂停 Leader 停止派发新任务与定时唤醒，保持连接与 `/stop` 可用，已运行任务默认允许完成并回报（另提供显式中止按钮）；暂停期间新到达的触发消息进入独立 **`paused_pending` 待审积压状态**（不混用门禁 `held`，也不采用原 `im-bridge` 改成终态 `ignored` 的破坏性行为），恢复后展示摘要由 Owner 选择重投并沿用原幂等键。 |
| 重置会话 | **适配落地** | 仅重置选定受众的模型上下文窗口，完整保留历史消息、文件、待办、提醒、长期记忆与 IM 连接；验收须验证下一轮实际模型请求不再携带被重置的旧上下文。 |
| 从另一段对话交接（Handoff） | **受控摘要导入** | 复用 T3 已有 `AgentSessionScanner.ts` 只读解析（绝不走会恢复活体运行时的 `AgentSessionImporter.ts`）及 `t3_thread_transfer`；提取带来源、目标作用域与内容哈希的结构化摘要，经 Owner 预览确认后按 L1/L3 规则写入目标记忆，不打断运行中任务。完整外部扫描 UI 排在 Slice 1 之后。 |
| 每日整理记忆（`tidy`）与诊断问题 | **复用调度并强制脱敏** | `tidy` 按 `(leaderId, companionScope)` 仅在空闲且有新增对话时执行，与手动交接防并发覆盖；诊断面板优先在应用内展示连接/配对/投递与错误，导出给模型的文本须先脱敏（剥离密钥、私有记忆与敏感路径）。 |

### 5. 对 ADR-011 §4 的修订与幂等迁移

- 伴侣目录由 `<数据目录>/companion/{ROLE.md,private/,groups/<chatKey>/}` 升级为：
  `<数据目录>/companion/leaders/<leaderId>/{ROLE.md,private/,groups/<chatKey>/}`
- **幂等无损迁移**：升级启动时把既有 `ROLE.md`、`private/`、`groups/` 与既有 IM 连接自动挂载到默认 Leader（`leader-default`），保留原 Thread ID、消息 ID、去重记录与钥匙串凭据引用；重复启动结果完全一致。

### 6. 明确排期延后的能力（受上述已定安全契约约束）

- **Stage 2**：简单「新建 Leader」入口与多 Leader 切换、Owner 私聊按项目/线程授权查桌面状态入口、外部会话扫描交接 UI、空闲 `tidy` 调度。
- **Stage 3 / 后续验收**：复杂渠道换绑 UI、非 Pi 远程运行时（Claude Code / Codex 逐个补齐目录隔离与单次审批钩子后开放）、多机器受保护任务转发（硬不变量：目标主机或 Provider 无法验证执行策略时一律 fail-closed 拒绝）。

### 7. Slice 2 增补与用户可见术语定名（2026-11-25）

为对齐产品体验与双语一致性，Slice 2 在保持全部底层安全不变量与数据库/API 向后兼容的前提下，确认并落地以下五项增量：

1. **统一领域术语（Ubiquitous Language）**：用户可见界面统一将 `Leader` 定名为中文 **「领航者」**、英文 **`Navigator` / `Navigators`**（上区分区标题用 `Navigators` 与下方 `Threads` 对称）；侧栏下方普通对话列表保持中文 **「对话」**（遵循术语规范，禁用「会话」「线程」）、英文 **`Threads`**。SQLite 表（`xtwork_leaders`、`xtwork_leader_bindings`、`xtwork_run_policies`）与 `/api/xtwork/im/leaders/*` 路由保持不变。
2. **沉浸式透明顶栏与占位标题拦截**：`[data-chat-header]` 改为透明背景直接融合主题画布（消除浅色/渐变主题下的纯白截断条）；`xtwork-leader-*` 领航者线程隐藏普通面包屑并将领航者身份、状态、Needs You、暂停/恢复与管理收束为单一顶栏；`ChatHeader` 隐藏免项目草稿的 `无文件夹 /` 前缀；`ThreadTitleRegenerationService` 跳过 `xtwork-leader-*` 自动改名并拒绝 `Unknown Subject` / `Untitled` 等退化占位标题；领航者改名时同步更新对应置顶线程标题。
3. **侧栏上下分栏（领航者 / 对话）**：桌面侧栏固定区清晰划分为上方 **「领航者」**（含 `+` 快捷创建与 `…` 菜单及领航者卡片列表）与下方 **「对话」**（含项目筛选、添加文件夹、新建对话与搜索框），避免入口混排。
4. **多领航者归档与 IM 渠道换绑**：新增 `POST /api/xtwork/im/leaders/:id/archive`（禁止归档默认领航者 `leader-default`；若存在活跃连接，拒绝静默遗弃或按 `rebindToLeaderId` 在单事务内换绑并同步 `im-bridge`；若仍存在未处理的暂停积压消息则拒绝归档，防止积压失去操作入口；已归档领航者不可被迟到请求恢复或修改）与 `POST /api/xtwork/im/connections/rebind`（递增 `bindingEpoch`、签发新 `bindingId` 并实时下发 `connections.syncBindings`，同步失败时显式上报 `syncPending: true` 并由后台轮询持续补偿，历史归属与暂停积压保留原领航者）；领航者管理面板与「设置 → 远程连接」两处均提供换绑选择器，且 `GET /api/xtwork/im/connections` 自动补全活跃绑定归属。
5. **IM 跨对话委派与进展汇报审批策略（`im_policy_json`）**：在 `xtwork_leaders` 持久化按受众（`ownerDm` / `group`）分级的 `imPolicy`，默认最小权限（`delegationMode: "always_ask"`、`progressReportMode: "completion_and_blocked"`）。服务端强制执行 **Capability Attenuation（权限收窄）**：`group` 受众永远不可开启 `scoped_auto` 或配置桌面 `allowedProjectIds`；新增只读 MCP 工具 `im__workspace_status`，在 Owner 私聊开启 `scoped_auto` 时仅对白名单文件夹放行状态查询，其余文件夹走单次桌面审批，`deny` 模式立即拒绝跨聊天与跨项目操作；`makeDeliverySync` 按受众 `progressReportMode` 控制 `phase_summary`（实时流式）、`completion_and_blocked`（检测到 `waiting` 或存在运行中待审批项时，通过 `messages.send({ preserveInboundState: true })` 发送阻塞提醒而不提前结算入站消息）与 `silent`（仅最终答复）。
6. **状态驱动动态 Bot 头像与静默 IM 在线/离线渠道指示（2026-11-26）**：
   - **本地 Vendor 零 WebGL 引擎**：在不修改上游 `pnpm-lock.yaml` 的前提下，将零依赖 MIT 引擎 `DominikScholz/open-bot-avatar` 的 2D Canvas/SVG 核心与全部 **23 款**造型（7 款内置 `examples` + 16 款 `gallery/*.json` 与默认调色盘）本地 vendor 到 `overlay/files/apps/web/src/components/leader/openBotAvatar/`（保持零运行时依赖，含原生 `PathError`），并在 `overlay/files/apps/web/public/LICENSE.open-bot-avatar` 保留完整 MIT 许可。
   - **版本化存储与宽容读取**：`xtwork_leaders.avatar` 在保留既有单字/徽章 8 字符截断与 `S29b` 空白回退契约的同时，仅放行合法 3/6 位 hex 的 `bot:v1:<shapeId>:<hexColor>[:<hexEyeColor>]` 配置；前端 `parseNavigatorAvatar` 宽容兼容历史纯文本头像并按 `leaderId` 确定性映射到默认 Bot 造型，对显式瞳孔色强制校验 `>= 3.0` WCAG 对比度并在不达标时自动回落至高对比瞳孔色。
   - **多源状态汇总与边沿单次庆祝**：服务端 `GET /api/xtwork/im/leaders` 补齐 `startingCount`、`waitingCount`、`failedCount`、`completedCount` 与基于 `latestRunCompletedAt + latestRunId`（排除手动停止的 `latestRunStopRequested` 与纯元数据 `updatedAt` 变更）的单调完成水位 `latestCompletedKey` / `latestCompletedAtMs`；前端 `navigatorAvatarModel.ts` 通过 `extractPinnedThreadSignal` 融合 `EnvironmentThreadShell.runtime.status`、`backgroundWorkHoldsCompletion(pendingBackgroundTasks)` 与 `shell.source` 实时流态（当领航者自身线程仍有 awaited 后台任务时，同时拦截自身与跨线程的 `done` 庆祝，直到后台任务真正结束），并与服务端跨线程/审批/暂停信号按最差严重度全序（`blocked > waiting > working > thinking > idle`）归约，对 `working`/`thinking` 降级施加 900ms 最小驻留防抖，`done` 庆祝严格作为边沿触发的不可重触发单次动画（约 3.99s，拒绝回退旧时间戳并在感知范围变更时静默重建基线，附带高优状态强制清零与 `visibilitychange` 隐藏休眠）。
   - **编辑/新建区无放回随机、单计时器轮询与渠道绑定生命周期**：领航者管理编辑面板提供 23 款造型网格、11 色快捷色板 + 自定义取色器、动作状态预览（庆祝预览支持重复点击重播并在单次动画结束后自动回落待机）与基于 Fisher–Yates 洗牌袋（避开当前造型与同屏已有造型）的「随机生成头像」按钮；侧栏新建表单同步提供预览与随机按钮，避免点击侧栏行头像误触改写身份。侧栏行移除「领航控制面」兜底副标题，未绑定任何已认领 IM 渠道时副标题留空单行居中；`xtwork_leader_bindings` 持久化 `platform`、`claimed`（仅首次认领生效后置 1，配对未认领不提前亮红点）与 `disconnected_at`（主动断开或桥接确认断连后在事务内关闭活跃绑定并写入断连墓碑，防止并发旧快照轮询或离线换绑复活已断连连接，同时避免归档报 `409` 且不把失效连接转给默认领航者，为原领航者保留绑定历史），桥接同步确认同时校验 `leaderId`、`bindingId`、`bindingEpoch`、`leaderPaused` 与单调 `pauseVersion`（防止旧概览响应或连续暂停/恢复同步失败误清 `pendingBindingSyncs`），仅对已认领、归属与暂停态均已同步（`syncPending !== true`）且传输 `state === "connected"` 的渠道亮绿点，其余已绑定渠道亮红点（叠加圆/方形状差异与在线/离线读屏文本）。`LeaderSidebarSlot` 与 `LeaderSupervisoryBar` 均采用单计时器串行防重叠、页面不可见自动休眠的轮询响应 `xtwork:leaders-changed`，保持顶栏 `28×28` 固定盒尺寸。
   - **原生 WKWebView 渲染与桌面交互健壮性契约**：静态 SVG 缩略图在 `mount.ts`/`render.ts` 显式写入双轴尺寸、`display:block;width:100%;height:100%;pointer-events:none`、`overflow="hidden"` 与每实例唯一 SVG ID 前缀，杜绝 WKWebView 默认 `300×300` 膨胀、指针拦截与同款静态头像 DOM ID 冲突；极浅体色头像自动启用中性底板衬色与细轮廓投影。管理面板 23 款造型网格、IM 策略卡片与领航者顶栏统一按自身容器宽度响应（窄分栏保留头像、可识别名字与操作入口，标题栏空白区保持可拖动）；管理与 Needs You 抽屉采用顶栏下浮动层并实时避让底部输入框（满足最小 `760×500` 窗口零遮挡），支持 `Escape` 关闭回焦、超过 8 项任务展开全部与暂停消息全文展开；管理保存基于打开面板时的基线快照仅 PATCH 实际改动字段（含 `imPolicy` 按 `ownerDm`/`group` 子字段增量提交，服务端在领航者写锁内与最新策略合并后执行权限收窄校验）并拒绝空白名字（前后端同步校验），新建成功按提交归属 epoch 仅清理对应草稿防刷新失败重复提交与迟到响应误清，归档收归独立危险区并经二次确认明示接管领航者与受影响渠道，无剪贴板实现时展示可手动全选复制的脱敏诊断文本；远程连接设置页在桥接不可用或状态请求异常时均降级为「无法确认在线」（保留最后已知设备信息）并区分传输态与领航者暂停/换绑同步态。

## Consequences and Trade-offs

- **收益**：在单一 T3 内核上统一 Capy Captains 主动主管体验与 Mingle 多渠道伴侣能力；把原依赖 `xtwork-im-` 线程前缀的安全机制升级为按 run 持久化的 fail-closed 策略；提前锁死多 Leader Schema、暂停积压、快照分享与环境变量安全边界，避免后续返工。
- **代价**：Slice 1 需在 T3 侧新增 Leader / Binding / RunPolicy 持久化表、改造 Pi 启动前策略校验、补齐 Needs You 聚合与侧栏顶部固定槽位，并修正 `im-bridge` 暂停时的消息状态流转。
- **第一条垂直实现切片（Slice 1）验收闭环**：
  - 落地多实例 Schema + 默认 Leader + `companion/leaders/<leaderId>/` 幂等迁移 + 按 run fail-closed 策略 + 侧栏顶部固定 Leader 槽位 + 聚合 `getAgentAwarenessSnapshot()` 与 `ImApprovals` 的 Needs You + Leader 暂停/配置基础面板；
  - 端到端与对抗验收必须覆盖：① 群里派活 → Pi 在本群作用域执行 → 桌面固定 Leader 自动看到进度与 Needs You → Owner 审批 → 原群收到结果 → 桌面私下 fork 续聊 → 原群追问读不到私有续聊；② 猜线程 ID、跨群查询、无前缀派生线程、缺失策略定时触发、策略切换新开 Pi 会话、换绑崩溃重放归属、快照分享哈希绑定、暂停积压与恢复重投。

## Migration Implications

- **平滑升级**：现有 `<数据目录>/companion/` 文件、`userdata/statev2.sqlite`、`im.db` 幂等记录与系统钥匙串条目全部无损兼容并自动归属默认 Leader。
- **上游与沙箱边界不变**：不修改上游 T3 `pnpm-lock.yaml`，`moejs` 沙箱零网络/零文件/零凭据边界维持不变。

## Related Decisions

- [决策索引](../../DECISIONS.md)
- [ADR-001 · 桌面架构](001-desktop-architecture.md)
- [ADR-004 · 通用任务体验](004-general-task-experience.md)
- [ADR-009 · 默认内置运行时 Pi](009-default-pi-runtime.md)
- [ADR-010 · 插件 v2 双轨运行时与模态承载](010-plugin-v2-runtime.md)
- [ADR-011 · 基于 Mingle 渠道层与伴侣范式的内置 IM 远程连接服务](011-mingle-im-bridge.md)
- [ADR-012 · 小瞳模型渠道与编码 Agent 委派](012-xiaotong-model-channels-and-coding-agents.md)
- [07 远程连接插件](../plan/07-远程连接插件.md)
- [08 通用任务化改造](../plan/08-通用任务化改造.md)
- [11 风险与待定](../plan/11-风险与待定.md)
