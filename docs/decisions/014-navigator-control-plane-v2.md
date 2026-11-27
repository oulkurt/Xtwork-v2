# ADR-014 · 领航员控制面 v2（同级派生、受控 Crew 工单、独立 Drive 与正交 Squad 小队）

- **Date** 2026-11-26
- **Status** Proposed（三方架构合议定稿 · 归入后续规划待办 [Q-14](../../DECISIONS.md#pending-decisions)，暂不排期开工）
- **Evidence** Confirmed（源码核对基于 `main@9d792e7` 及当前工作树；经 Gemini 4 Neon、Codex GPT-6.2 Astra Max 与 Gemini 4 Carbon 三方独立审查达成一致，并核实 [Capy Captains](https://docs.capy.ai/captains) 与 [Multica Squads](https://github.com/multica-ai/multica/blob/main/apps/docs/content/docs/squads.mdx) 一手文档与源码）

## Context

[ADR-013](013-leader-supervisory-threads.md) 已完成领航员（`Navigator`，底层表沿用 `xtwork_leaders`）Slice 1 / Slice 2 落地：桌面侧栏「领航员 / 对话」上下分栏、动态 Bot 头像、多领航员创建与归档、IM 渠道原子换绑、按受众分级的 `im_policy_json` 以及按 run 持久化 fail-closed 的 `xtwork_run_policies`；[ADR-012](012-xiaotong-model-channels-and-coding-agents.md) 已完成内置助手「小瞳」多渠道模型平面与六大外部编码 Agent 委派路由。

在此基础上，产品明确了领航员下一阶段的演进愿景，并提炼出清晰易懂的四角色心智模型：

1. **领航员（Navigator · 控制面）**：用户日常对接的长期主管，按领域或渠道存在，负责接收指令、维护计划与规则、统筹进度，并在需要拍板或遇阻时通过 `Needs You` 找人。
2. **工作对话（Crew · 数据面）**：建在具体已授权项目文件夹里的工单对话，承接实际改代码、跑测试和 M1c 编码 Agent 委派。
3. **工作笔记（Drive · 外置工作态）**：每位领航员独立的持久化规范与计划目录（`NAVIGATOR.md` 主管私有规范、`CREW.md` 工单执行规范、`NOTES.md` 工作笔记），使领航员跨天、重置对话仍不丢失规矩与上下文。
4. **小队（Squad · 正交路由层，Phase 2）**：参考 Multica Squad，作为独立于领航员身份的可复用人员/领航员名册，在需要多工种接力的任务上按职责路由并带硬上限兜底。

同时，产品已统一中文用户可见术语为 **「领航员」**（英文保持 `Navigator` / `Navigators`）。

## Problem

三方核对当前源码后确认，要在不破坏 [ADR-011](011-mingle-im-bridge.md)、[ADR-012](012-xiaotong-model-channels-and-coding-agents.md) 与 [ADR-013](013-leader-supervisory-threads.md) 既有安全不变量的前提下，赋予领航员「桌面高权限 + 一句话建同级领航员 + 项目工单派活 + 独立笔记 + 正交小队」，必须先闭合以下 5 类核心架构缺口及 4 处现存代码隐患：

1. **`scratch` 工作目录错位与裸 `t3_thread_launch` 越权**：
   - `ensureLeaderDesktopThread`（`overlay/files/apps/server/src/im/XtworkImService.ts`）将置顶领航员对话建在 `scratch`，而 M1c 本地委派硬绑定父线程所属项目，领航员在置顶对话里无法直接切目录派编码活。
   - 若直接放开上游裸 `t3_thread_launch`，既不校验「查看状态权 ≠ 改代码派单权」，且上游本机调用会丢弃 `delegatedFrom` 导致新线程失去归属记录并绕过并发限流。
2. **默认 `awarenessScope = all_local` 与桌面只读工具穿墙**：
   - `XtworkLeaderStore.ts` 中 `DEFAULT_AWARENESS_SCOPE` 默认为 `all_local`，且 `XtworkImService.ts` 创建/编辑接口对未知值也会回落 `all_local`。
   - 更隐蔽的是：桌面领航员线程目前不是受保护线程，`t3_thread_list` / `t3_thread_read` / `t3_thread_search`（默认搜调用方所在的 `scratch`，而全机所有领航员和所有 `xtwork-im-*` 聊天都挂在 `scratch` 下）免确认直通，导致受限领航员可绕过侧栏直接读出其他领航员的对话与 IM 聊天记录；对于本机文件访问，产品确认桌面领航员的只读查看（`read` / `grep` / `find` / `ls`）越界自动放行，但编辑、删除、命令执行等写操作必须交由用户决定（IM 受保护线程仍维持原有沙箱隔离）。
3. **`source: "desktop" | "im"` 分不清「人亲手下令」与「自动唤醒」，且策略落库与 IM 保护态耦合**：
   - `TurnExecutionContext` 仅有 `desktop | im`，无法区分桌面本人敲回车与定时任务、工单回报、跨领航员留言等自动唤醒。
   - 现有 `persistPolicyBeforeLaunch` 会同时写入 `xtwork_run_policies` 与 `xtwork_protected_threads`；若直接给桌面线程写策略，会误触发 IM 受保护态，同时封死 M1c 编码委派、隐藏 `t3_*` 工具并强制私聊 fork。
4. **只读日报（Digest）侧信道泄密面**：
   - 桌面 Owner 日报含私有项目标题与审批参数，绝不可静态落盘到所有人或 IM 私聊可读的目录；且现行 `buildScopedAwareness` 仍返回 `threads[].title` 与 `detail`，对外（跨领航员 / 群聊）需要仅含状态计数的脱敏投影。
5. **多领航员侧栏 `N+1` 放大与并发/死循环失控**：
   - `GET /api/xtwork/im/leaders` 对每个领航员分别调用一次 `fetchLeaderOverview`，导致 `connections.list`、`connections.syncBindings`、`paused.list` 与 `getAgentAwarenessSnapshot()` 按领航员数量线性放大。
   - 并发限流若用自管状态位占坑，遇到崩溃或 `/stop` 会永久死锁；而跨领航员自动互回或无上限续派会引发死循环烧干 Token。
6. **需顺手收口的 4 处现存实现坑**：
   - `reset-session` 新建 `xtwork-leader-*` 置顶线程前未归档旧 `pinnedThreadId`，导致旧线程掉进下方普通「对话」列表且缺失控制顶栏；
   - 领航员工作笔记（Drive）若放进 `companion/leaders/<id>/private/` 会被 Owner DM 的 `im__memory_read` 读出，且 `XtworkImMemory.ts` 尚缺并发写锁与乐观校验；
   - 归档领航员目前只检查 `im-bridge` 暂停积压，未拦截在途 Crew 工单，也未清理排队工单与挂起的内存 `ImApprovals`；
   - `XtworkImService.ts` 与 `XtworkImDispatch.ts` 仍硬编码 `xtwork/standard` 模型，未动态跟随 M1b 当前生效的小瞳默认模型；顶栏轮询也存在冗余串行请求。

## Considered Alternatives

| 议题 | 备选方案 | 裁决与理由 |
|---|---|---|
| **领航员高权限边界** | A：照搬 Capy 的 `acts as its owner`（任何人发消息均用 Owner 身份执行）<br>B（采用）：**桌面 `desktop_user` 放权 × 多受众按回合能力衰减** | **采用 B。** Xtwork 会直接把答复回发到飞书/企微/微信群，照搬 A 会直接引发混淆代理人（Confused Deputy），击穿 `035` / `043` / `046` 三道防线。 |
| **领航员新开领航员拓扑** | A：父子嵌套督导树（Sub-Navigator 挂进父级 Crew 或 T3 子任务树）<br>B（采用）：**同级派生工厂（Peer Factory）** | **采用 B。** T3 父子任务树自带递归取消语义（ADR-012），嵌套会导致停止/归档 A 误杀 B；同级创建仅记录创建溯源（`provenance`），新领航员独立归属 Owner、从干净 Drive/空渠道起步。 |
| **固定总管定位（CEO vs 大管家）** | A：强层级「CEO」（所有专项领航员归其下辖、汇报统一先经其转述）<br>B（采用）：**固定「大管家 / 幕僚长（Chief of Staff）」**，复用不可归档的 `leader-default`（「小瞳」），用户本人当 CEO | **采用 B。** 强层级 CEO 会让指令/结果多走两趟、易传丢约束并把单条对话塞爆，且一旦绑群极易触发跨受众泄密；大管家只做桌面固定接待分流、授权范围总览与渠道归档兜底，所有领航员仍直接对用户负责，跨项目统筹交由 Slice C 按需编组的 Squad 协调人承担。 |
| **一句话建领航员交互** | A：桌面对话免确认直建一个 `none` 空壳领航员<br>B（采用）：**单次预填确认卡（含名字、随机头像、角色与建议文件夹勾选）** | **采用 B。** 防止随口讨论污染侧栏、阻断网页/文档中的间接提示词注入刷屏，且一次确认同时完成授权盖章与文件夹绑定，比建完空壳再去设置页点多步更顺手。 |
| **Crew 工单完成后的领航员反应** | A：严格 0 次自动模型调用（纯静态记账）<br>B：允许自动续派下一张工单<br>C（采用）：**防抖合并至多 1 次受限 `auto` 消化回合** | **采用 C。** A 会阉掉“主管替你验活记笔记”的核心体验；B 有死循环风险；C 在 `auto` 回合硬禁派单、硬禁 `delegate_task` 与建领航员，仅允许读结单摘要、更新 Drive 笔记并挂出下一步建议卡，兼具体验与数学有界性。 |

## Decision

本方案作为**后续规划待办**分三个可独立验收的垂直切片推进，严守 [ADR-006](006-upstream-update-policy.md) 薄改上游原则（不修改上游 `pnpm-lock.yaml`，核心逻辑全部落于 `overlay/files/`，新增上游补丁届时同步登记 [02-上游与改造层.md](../plan/02-上游与改造层.md#4-实建补丁台账as-built)）。

### 固定总管定位（复用 `leader-default`「小瞳」作大管家，用户本人当 CEO）

复用既有、不可归档的默认领航员 `leader-default`（「小瞳」）作为全局固定大管家（不新增上下级老板层级，所有专项领航员仍直接对用户负责）：

- **独有的 3 项默认职责**：
  1. **固定接待与分流**：桌面始终保留可触达入口；用户不确定找哪位专项领航员时，由其推荐并一键跳转至对应专项（或经单次确认卡协助新建）。
  2. **桌面全局总览**：在桌面端按用户授权范围汇总“哪些事在等我拍板”，点击直达原任务；首次安装默认仅授予状态只读范围 `all_local`（用户可自行收窄，升级保留用户设置），**项目改代码派单权 `dispatchProjectIds` 仍独立授权**。
  3. **渠道兜底接管**：用户确认归档某个专项领航员时，默认承接其仍绑定的 IM 渠道新消息，历史消息保留原归属。
- **明确不能有的 3 项权力**：
  1. 不强制专项领航员先向总管汇报、不拦住用户直接找专项，也不把专项领航员挂进总管的子任务取消树；
  2. 不跨受众传话——桌面私事、其他群进度与审批详情绝不可在当前群聊汇总中泄出；
  3. 不凭总管身份代用户批准危险操作、不向未授权项目直接派发代码工单、不读取其他领航员的私有 Drive 笔记。

### 核心不变量（开工落地时不可妥协）

1. **查看权与派单权分离**：`awarenessScope`（能看哪些项目状态）与 `dispatchProjectIds`（能直接派 Crew 工单改代码的项目白名单）独立存储与校验；未在白名单的项目派单必走桌面单次确认。
2. **默认最小权限**：仅首次安装的默认领航员「小瞳」显式写 `all_local`（老用户已有设置升级保留）；所有新建领航员默认 `none`，模型侧创建接口拒收 `all_local`。
3. **服务端不可伪造 `triggerOrigin` 与单向保护锁**：每轮由服务端在入口盖章 `desktop_user | im_inbound | auto` 并原子绑定 `runId`；保护态（`xtwork_protected_threads`）单向不可逆，绝不允许把 IM 线程洗白成桌面回合。
4. **实时快照单一事实源**：不落盘面向多受众的静态万能日报；桌面 Owner 走 `buildOwnerNeedsYou`，跨领航员与 IM 统一走先过滤后计数的 `buildCountsOnlyAwareness`。
5. **物理隔离的 Drive 与零死锁并发闸门**：工作笔记存于 `<dataDir>/leaders/<leaderId>/drive/{NAVIGATOR.md,CREW.md,NOTES.md}`，对 `im__memory_*` 不可见；整机并发槽位实时从 `ProjectionStore.getAgentAwarenessSnapshot()` 推导并配短启动租约，崩溃或 `/stop` 自动释放。
6. **正交 Squad 不扩权、防乒乓**：加入同一小队绝不合并成员的 `awarenessScope`、`dispatchProjectIds` 或 `private/` 记忆；直交接强制硬跳数上限与全局共享并发预算。

### Slice A · 地基加固与性能修复（优先落地切片）

- **用户感知价值**：多领航员侧栏刷新零卡顿；新建领航员默认隔离且空态引导清晰；彻底堵住跨领航员/跨项目偷看；顺手修复重置对话漏线程与硬编码模型问题。
- **规划改动范围**：
  1. **Store 与安全策略**（`XtworkLeaderStore.ts`、`XtworkImSecurity.ts`）：
     - `xtwork_leaders` 新增 `dispatch_project_ids_json TEXT NOT NULL DEFAULT '[]'`；`createLeader` 默认 `awarenessScope` 改为 `none`，`parseAwarenessScope` 遇脏数据 fail-closed 回落 `none`；
     - `xtwork_run_policies` 新增 `trigger_origin TEXT NOT NULL DEFAULT 'auto'`（老行按 `source` 回填，**不改动 `computePolicyDigest`** 以保兼容）；按 `protectedExecution(context)` 拆分「写桌面来源」与「登记 `xtwork_protected_threads`」，加单向保护锁防降级。
  2. **去 `N+1` 与脱敏投影**（`XtworkImService.ts`、`XtworkImDispatch.ts`、`XtworkLeaderAwareness.ts`）：
     - `GET /api/xtwork/im/leaders` 改为批量单次拉取公共数据（1 次 `connections.list` + 至多 1 次合并 `connections.syncBindings` + 1 次 `paused.list` + 1 次 `getAgentAwarenessSnapshot()`），内存按领航员过滤；
     - 新增 `buildCountsOnlyAwareness`（仅返状态计数，剥离标题/细节/审批参数）；`POST /leaders` 与 `/update` 拒收非法 `awarenessScope.kind`（返 `400`）；`reset-session` 切换前自动归档旧 `pinnedThreadId`；动态读取当前生效小瞳默认模型替代硬编码 `xtwork/standard`；仅在 `connections.list` 成功时附带 `triggerReplay: true`。
  3. **规划薄补丁（`049`，届时新增）**：在桌面消息入口盖章 `triggerOrigin` 并于 `EventSink` 事务内为非受保护线程原子绑定 `run_id`（同步绑定 `McpSessionRegistry` 的 `runId`）；对 `xtwork-leader-*` 的 `t3_thread_*`（`list/read/search/send/wait/configure/transfer/interrupt/organize`）、`t3_queue`、`t3_pending_request`、`t3_project_list/read` 统一套上 `awarenessScope` 门禁（严格隔离 `scratch` 下其他领航员与 IM 线程，并消除跨线程只读的 `thread-read-acknowledge` 副作用）；桌面领航员的 Pi 原生只读工具（`read`/`grep`/`find`/`ls`）对越界路径保持自动放行，编辑、删除与命令执行等写操作统一保持用户确认门禁（`auto` 回合硬禁无确认写入）。
  4. **前端 UI**（`LeaderSidebarSlot.tsx`、`LeaderSupervisoryBar.tsx`）：新建小表单增加可选文件夹勾选；`none` 空态明确提示未关联文件夹并提供一键跳转管理设置按钮；去掉顶栏冗余串行请求。
- **验收标准**：老数据升级保留「小瞳」设置与既有会话摘要；5 领航员刷新快照/桥接调用严格为 1 次；受限领航员调 `t3_thread_search()` 搜默认 `scratch` 或猜 ID 100% 被拒；桌面 M1c 编码委派零误伤；存量测试与 `node scripts/check-docs.mjs` 全绿。
- **Out of Scope**：本切片不引入自然语言建领航员、Crew 跨项目派单、Drive 目录与 Squad。

### Slice B · 桌面一句话建领航员 + 受控 Crew 工单 + 独立 Drive 笔记

- **用户感知价值**：桌面一句话弹出预填确认卡即可新建带好文件夹权限的同级领航员；交代项目任务时领航员自动在目标仓库开规范 Crew 工单运行编码（全机默认最多并发 2 单、永不死锁），跑完自动整理结论写进独立笔记并汇报。
- **规划改动范围**：
  1. **新增服务端模块**（`overlay/files/apps/server/src/im/`）：
     - `XtworkLeaderDrive.ts`：管理 `<dataDir>/leaders/<leaderId>/drive/{NAVIGATOR.md,CREW.md,NOTES.md}`，内置 `KeyedLock(leaderId, file)` + `expectedSha256` 乐观并发校验 + 单文件 `32 KiB` 上限 + 回合注入截断摘要（单文件 `8 KiB`）。
     - `XtworkCrewScheduler.ts`：管理 SQLite 表 `xtwork_crew_threads`（含 `UNIQUE(leader_id, client_request_id)`、`auto_coding_used`、`digest_dispatched`）与 `xtwork_leader_create_proposals`（`run_id UNIQUE` 实现单回合一次确认只建一个、重放幂等）；2 槽限流器实时从 `getAgentAwarenessSnapshot()` 计数 + 30s 短启动租约；工单终态经 3–5 秒防抖合并触发至多 1 次 `triggerOrigin = "auto"` 的只读/记笔记消化回合。
     - `XtworkNavigatorMcp.ts`：仅对桌面 `xtwork-leader-*` 暴露 `navigator__propose_peer`、`navigator__dispatch_crew`、`navigator__drive_read` / `navigator__drive_write`、`navigator__peer_status`（内部调 `buildCountsOnlyAwareness`），IM 受保护线程硬屏蔽。
  2. **规划薄补丁（`050`，届时新增）**：挂载 `XtworkNavigatorMcp` 并在 `xtwork-leader-*` 隐藏裸 `t3_thread_launch` / `create_threads`；在 `OrchestratorMcpService.delegateTask` 对 Crew 工单执行「单工单最多自动派 1 次编码工作（同 `commandId` 重试幂等放行），第 2 次转入 `Needs You`」；回合启动注入 Drive 摘要；`XtworkImService` 归档领航员时拦截在途运行 Crew 工单、自动取消 `queued` 工单并拒绝清理挂起内存审批。
  3. **前端 UI**：顶栏与 Needs You 支持新建领航员确认卡、未授权项目派单确认卡与下一步建议卡，并新增轻量「工作笔记」抽屉。
- **验收标准**：Crew 工单准确绑定目标项目 `cwd` 并成功走通 1 次 M1c 委派；3 单连发遇到崩溃、`/stop`、人工等待与服务重启均自动补位无死锁；`auto` / `im_inbound` 回合严禁建领航员或续派工单；Drive 并发写无丢写且对 `im__memory_*` 不可见。
- **Out of Scope**：不做领航员之间自动互聊或互派工单；定时汇总若开启仅用零模型模板；IM 回合继续硬禁外部编码 CLI。

### Slice C · 正交 Squad 小队路由层（Phase 2）

- **用户感知价值**：将多名专职领航员编组为可复用小队，先由牵头领航员按职责分工中心派单，跑稳后开放带跳数熔断与人类确认门禁的跨领航员有界交接。
- **规划改动范围**：
  1. **新增 `XtworkSquadStore.ts`**：新增正交表 `xtwork_squads`（`handoff_mode` 默认 `hub_only`，后续开放 `bounded_handoff` 且硬上限 `max_hops = 1`）与 `xtwork_squad_members`（`specialty_tag`、`allowed_project_ids_json`）；归档成员领航员时自动移出或提示更换协调人。
  2. **API 与 MCP（零新增上游补丁）**：扩展 `/api/xtwork/im/squads` 与 `XtworkNavigatorMcp`（`navigator__squad_roster`、`navigator__squad_assign`），与整机共用同一套 2 槽并发限流器；交接时同时核验发送方授权与接收方自身 `dispatchProjectIds`，跨项目权限缺口一律落桌面 `Needs You` 单次确认。
  3. **前端 UI**：侧栏领航员菜单增加轻量「小队编组」弹窗。
- **验收标准**：对抗验证“低权成员向高权成员借刀越权”必拦截、`A → B` 达 `max_hops = 1` 后禁止再回传或转交并进入 `Needs You`、多成员并发共享整机 2 槽上限不翻倍。

### 可在开工前微调的默认参数

| 参数 | 建议默认值 | 说明 |
|---|---|---|
| 整机并发 Crew 工单上限 | `2` | 实时快照计数 + 30s 启动租约，多出排队 |
| 单工单自动编码委派上限 | `1` 次 | 完成后记结果，第 2 棒或失败进 `Needs You` |
| Crew 终态防抖消化回合 | `3–5s` 合并至多 `1` 次 | `auto` 回合仅允许读结单与写 Drive，硬禁续派 |
| 对话新建领航员门禁 | 桌面单次确认卡 | 预填名字/头像/角色/文件夹，一次确认幂等建 1 个 |

## Consequences and Trade-offs

- **收益**：在守住既有 IM 受众隔离、按 run fail-closed 策略与薄改上游红线的前提下，将领航员从“多渠道伴侣控制栏”平滑升级为可控、防死锁、防烧钱的长期项目主管，并为后续 Squad 多专家协同留出干净的正交扩展面。
- **代价**：需在 Slice A 补齐桌面领航员对 `t3_thread_*` / `t3_project_*` 的范围校验与写操作确认门禁，并引入 2 份极薄上游钩子补丁；Slice B 的单次确认卡与 2 槽/1 次自动委派护栏在重度自动化场景偏保守，待真机跑顺后再按实测放宽。

## Migration Implications

- **老数据零损平滑升级**：存量 `leader-default`（「小瞳」）保留既有 `awarenessScope`（含老用户已手动修改的值）；`xtwork_run_policies` 新增 `trigger_origin` 列且不改变 `computePolicyDigest` 计算公式，既有活跃会话不会因升级误重开。
- **上游与沙箱边界不变**：不修改上游 `pnpm-lock.yaml`，`moejs` 沙箱与 `im-bridge` 零明文凭据不变量完全维持。

## Related Decisions

- [决策索引 · Pending Decisions](../../DECISIONS.md#pending-decisions)
- [ADR-006 · 上游 T3 Code 同步策略](006-upstream-update-policy.md)
- [ADR-011 · 基于 Mingle 渠道层与伴侣范式的内置 IM 远程连接服务](011-mingle-im-bridge.md)
- [ADR-012 · 小瞳模型渠道与编码 Agent 委派](012-xiaotong-model-channels-and-coding-agents.md)
- [ADR-013 · Leader（Captain 式主管实体）、侧栏置顶入口与 Mingle 能力移植边界](013-leader-supervisory-threads.md)
- [02 上游与改造层](../plan/02-上游与改造层.md)
- [10 里程碑与验收](../plan/10-里程碑与验收.md)
- [11 风险与待定](../plan/11-风险与待定.md)
