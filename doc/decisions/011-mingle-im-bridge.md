# ADR-011 · 基于 Mingle 渠道层与伴侣范式的内置 IM 远程连接服务

- **Date** 2026-11-24
- **Status** Accepted
- **Evidence** Confirmed · 2026-11-24 项目负责人确认方向，并经 Gemini 4 Neon 与 GPT-6.2 Sol 五轮联合架构与安全评审；代码基准核对自 `earayu/Mingle@006220e8`（MIT）与锁定上游 `t3code@3ce2145`

## Context

小瞳 Work v2 需要把日常助手接入用户已经在用的 IM，解决“手机上给机器人派活、电脑桌面打开同一条对话继续做，并与待办/日程/笔记共享数据”的核心场景。原规划（[07 远程连接插件](../plan/07-远程连接插件.md)）设想在 Go `plugin-host` 内自研各平台连接器并配 moejs worker，但实现成本高，且每个平台的扫码建应用、长连接保活、流式回复和媒体收发细节繁杂。

外部开源项目 [earayu/Mingle](https://github.com/earayu/Mingle)（`006220e880d2134665ce2745ab6233f52c8eabe9`，MIT 许可）已经实现了高度解耦的 TypeScript/Node `Channel` 抽象层与 10 个出站长连接/长轮询渠道，同时验证了一套成熟的长期伴侣范式（`ROLE.md`、`MEMORY.md`、`notes/`、通讯录与跨 IM 人物关联、自然语言无会话命令交互、群背景消息沉淀等）。

但 Mingle 本身是一套完整的独立 Agent 运行时（自带 `@botiverse/oar`、独立 SQLite、独立任务与提醒、`mingle` CLI、独立控制台和 mygo 壳），且默认采用“OAR 关闭交互审批与沙箱 + 组织平台默认放行全员 + 跨群记忆不隔离”的无人值守安全模型，与 Xtwork v2 的 T3 编排内核、moejs 沙箱（[ADR-010](010-plugin-v2-runtime.md)）和安全基线存在本质差异。

## Problem

如何把 Mingle 极具价值的多 IM 渠道接入能力与伴侣范式引入 Xtwork v2，做成“内置插件开关默认打开”的体验，同时避免：

1. 制造双脑割裂（两套 Agent、两套对话与记忆、两套待办/提醒，IM 任务无法操作 Xtwork 自己的待办/日程/笔记）；
2. 破坏 [ADR-007](007-plugin-contract.md) / [ADR-010](010-plugin-v2-runtime.md) 对 moejs 插件的纯沙箱约束（无网络、无文件、无凭据）；
3. 污染上游 T3 Code 的 `pnpm-lock.yaml` 与升级路径（[ADR-006](006-upstream-update-policy.md)）；
4. 在第一版开放群聊的前提下，引入无人值守命令执行、Provider 原生只读工具越界读盘、私有待办/记忆泄露和持久化提示词注入风险。

## Considered Alternatives

| 方案 | 概要 | 结论 |
|---|---|---|
| **方案 A：整包嵌入 Mingle Sidecar** | 直接把完整 Mingle（含 OAR、独立 SQLite 与控制台）作为子进程打包 | **拒绝作为内置方案。** 会形成两套平行产品，无法自然复用 T3 对话、内置 Pi、模型网关和待办/日程/Obsidian MCP 插件，且继承 OAR 免审批高危边界。 |
| **方案 B（采用）：拆取 Mingle 渠道层与状态机做成 T3 侧独立 Node `im-bridge`，在其上对齐 Mingle 伴侣范式** | 按固定提交 vendoring Mingle MIT 渠道适配器、连接/入站/门禁状态机与系统钥匙串适配，作为 T3 监管的受信 Node 子进程运行；T3 作为唯一编排、工具与审批底座，同时对齐 Mingle 的 `ROLE.md`/`MEMORY.md`/`notes/`、通讯录/人物和群背景体验 | **采用。** 复用 Xtwork 已随包携带的 Node `26.13.1`，不改上游 T3 `pnpm-lock.yaml`，不破坏 moejs 沙箱，单一事实来源且同时获得 Mingle 的能力层与伴侣体验。 |
| **方案 C：保留 Mingle Core，将 OAR 替换为 Xtwork Harness** | 保留 Mingle SQLite 与伴侣核心，只换底层 harness | **拒绝。** 仍造成双 SQLite、CLI 与 MCP 重复、待办/提醒双轨和线程映射冲突。 |
| **原方案：在 Go `plugin-host` 内自研 IM 连接器** | Go 重写各平台 SDK + moejs worker 映射 | **替代。** 企微、飞书扫码建应用等官方 SDK 在 Node 生态更完善，重复造轮子成本过高。Go `plugin-host` 继续专注 moejs 功能插件。 |

## Decision

### 1. 进程边界、启动契约与打包方式

- IM 远程连接作为 Xtwork v2 的**内置受信扩展服务**运行，而非不可信第三方 moejs 插件。Go `plugin-host` 与 `moejs` 沙箱不新增原始网络、进程或凭据能力，[ADR-010](010-plugin-v2-runtime.md) 的双轨边界保持不变。
- 在本仓库新增独立子包 `im-bridge/`（自带独立锁定的 `package.json` / `package-lock.json`，打包方式对齐 `runtime/pi/`），**不修改上游 T3 的 `package.json` 或 `pnpm-lock.yaml`**。
- **启动与握手契约**：mygo 外壳向 T3 服务端传入绝对路径 `XTWORK_IM_BRIDGE_ENTRY`（指向包内 `Resources/im-bridge/dist/main.js`）、`XTWORK_IM_DATA_DIR` 与 `XTWORK_COMPANION_DIR`。T3 服务端通过 `overlay/files/apps/server/src/im/` 的薄桥接层，**强制使用 `process.execPath`（随包 Node `26.13.1`，不查 `PATH`）**监管 `im-bridge` 子进程，启动时通过双向 JSONL 执行 `hello` 协议与版本握手，异常退出时指数退避重启；应用退出时 T3 先优雅关闭 `im-bridge` 断开长连接，再退出。

### 2. 「内置插件开关默认打开」的四态生命周期

不把“默认打开”简化为单一布尔值，拆分为四个清晰状态：

1. **`installed = true` & `uiVisible = true`（默认开启）**：随应用打包，在设置页与插件列表中默认可见且开关打开，无需另行安装或打开开发者模式。
2. **`idle`（未绑定，默认静默）**：用户尚未绑定任何 IM 平台前，零外网长连接、零后台轮询、不触发系统隐私权限弹窗。
3. **`pairing`（临时配对态）**：当接入流程需要通过私聊验证码认领 Owner 时（企业微信扫码/手填凭据、飞书手填凭据，以及飞书扫码响应缺少 `ownerId` 时的兜底），`im-bridge` 建立受限临时连接——**仅接收该连接的 6 位一次性认领码私聊（10 分钟有效，错 5 次作废）**，拒绝其他所有消息且绝不唤醒 T3 或 Pi；认领成功后才切入 `active`。
4. **`active`（已激活）与 `backgroundRuntime`（绑定后引导）**：Owner 认领完成后开放正常任务收发；首次绑定成功后引导用户按需开启关窗托盘常驻、登录自启与插电保活（具体默认引导随 `Q-07` 验收）。

### 3. 首发平台范围与上游治理（收口 Q-04）

- **首发三平台**：**飞书（Feishu）**、**个人微信（腾讯 iLink）**、**企业微信（WeCom 智能机器人）**。
  - 仅新增 2 个 MIT 许可的 npm 生产依赖：`@larksuiteoapi/node-sdk@1.76.0`、`@wecom/aibot-node-sdk@1.0.7`；个人微信 iLink 基于纯 `node:crypto` + `fetch`，零外部依赖。
  - 完整保留 Mingle `Channel` / `ChannelConnection` / `OnboardingEvent` 平台无关契约，核心层不出现平台名分支；后续可低成本增量启用钉钉、QQ、Slack、Discord、Telegram、macOS iMessage、GitHub。
- **平台策略与显式约束**：
  - **飞书**：
    - **单 App 单活约束**：飞书同一企业自建应用多客户端接入时事件随机投递，首版要求每个 Xtwork 实例独立配置飞书应用；同时保留每连接独立 `DefaultCache`，避免同进程下**不同**飞书机器人在同群共享 SDK 进程级缓存而丢消息。
    - **最小权限首通 + 按需补权**：扫码建应用默认仅申请基础权限（私聊 + 群 `@` + 卡片/回执/资源/基础用户信息），避免敏感权限导致开启审核的企业租户卡死首通；读取未 `@` 群背景（`im:message.group_msg`）、`*.include_bot`、成员资料与文档评论作为可选权限支持二次扫码补开。
  - **企业微信**：走官方智能机器人 WebSocket 长连接与原生流式回复（含 9 分钟流式窗口交接与主动发送兜底）；官方仅推私聊与群 `@` 消息（无未 `@` 群背景）。
  - **个人微信（iLink）**：首发按 iLink 现有能力主打私聊闭环（含图片/文件 AES-128-ECB CDN 收发与多账号 `local_token_list`），群聊、实名/PIN、主动发送及第三方分发边界经真机验收后再定公开发布范围。
- **端到端幂等、崩溃恢复与游标顺序**：
  - 入站消息先经门禁判定最终落库状态：**只有通过门禁、应交给 T3 处理的触发消息**以 `received` 状态进入待投递队列（未放行记 `held`，已拒绝记 `blocked` 并丢弃，已放行群的无关背景记 `ignored`）。`im-bridge` 投递给 T3 时携带稳定幂等键 `im:<connectionId>:<platformMsgId>`；T3 在创建/追加回合时原子持久化该幂等键，若 `im-bridge` 收到确认前崩溃，重启时**只扫描已通过门禁且未获 T3 确认的 `received` / `delivered` 触发记录**按同一幂等键补投，T3 幂等返回既有 `(threadId, turnId)`，保证**同一外部消息最多创建一个 T3 回合**，且绝不把 `held` / `blocked` / `ignored` 误投给 T3。
  - **工具写入去重边界**：回合级幂等键只防重复创建回合；同一回合内 MCP 请求重发受 `operationKey` 去重；若回合已进入执行中（可能已调用 `todo__create` 等写工具）后发生进程崩溃，重启后**不自动盲重跑该回合**，而是在桌面标为中断供用户核对（或由写工具层按 `(turnId, toolCallId)` 显式幂等保护），防止重复写入待办。
  - 个人微信 iLink 长轮询必须遵循**先将本批入站消息经门禁分类（触发消息记 `received`，其余按真实状态落库）并与去重记录一起持久化到 `im.db`，再提交并持久化 `getupdates` 游标**的顺序；即使落盘后、T3 受理或确认前崩溃，重启也只会从 `im.db` 补投已通过门禁且未获 T3 确认的 `received` / `delivered` 触发消息，不丢消息、不越权放行也不重复建回合。
- **上游代码治理**：从 `earayu/Mingle@006220e880d2134665ce2745ab6233f52c8eabe9` 按固定快照 vendoring 渠道层与状态机，不盲追上游 `main`；在 `im-bridge/THIRD_PARTY_NOTICES` 完整保留 Mingle、`dsh-im` 及官方 SDK 的 MIT 版权声明。

### 4. 任务映射与对齐 Mingle 产品范式

- **桌面侧栏只出现发给机器人的任务**：
  - 入站消息**先过门禁再决定是否入背景缓存**：未放行群（`held`）仅保留等待 Owner 审阅的触发消息，被拒绝（`blocked`）的群与联系人静默丢弃且绝不入背景检索；仅已放行群里未 `@` 机器人的聊天记为 `ignored` 并计入 `unseen`，存入 `im-bridge` 本地 SQLite（FTS5 `trigram`），**不创建 T3 Thread、不出现在桌面侧栏、不触发模型调用**。
  - 只有发给机器人的消息（私聊、已放行群的 `@机器人`、回复机器人消息、话题内跟进）才会路由到 T3 创建或续聊对应的 T3 Thread，在桌面侧栏带 IM 来源标识展示。
  - **群聊旁听（`hearing.ts`）边界**：首版默认关闭且不在 M4.1–M4.3 开放；后续作为按群显式授权的可选能力启用时，须明确告知额外模型开销，且**旁听评估本身绝不创建桌面侧栏 Thread**（仅在后台静默判断是否发言）。
- **对齐 Mingle 伴侣范式（长在 T3 之上，兼顾隐私边界）**：
  - IM 侧以助手伙伴为一等对象，不暴露 `/new`、`/switch`、thread ID 等底层会话命令；IM 内唯一命令为 Owner 的 `/stop`。
  - 沿用 Mingle 的结构化消息头、200 字引用预览、附件按需下载（不自动落盘）、通讯录 `contacts` 与跨 IM 显式人物关联 `people`（Agent 关联不传递权限，Owner 账号只能由 Owner 在桌面关联）。
  - **分层伴侣目录（保留 Mingle `ROLE.md` / `MEMORY.md` / `notes/` 约定，同时堵住跨群泄露）**：
    - `<数据目录>/companion/ROLE.md`：公开角色定义，私聊与群聊共享；
    - `<数据目录>/companion/private/`（`MEMORY.md` + `notes/`，64 KB 软上限 + 空闲 `tidy`）：**Owner 跨飞书/微信/企微所有私聊完全共享同一份记忆**；
    - `<数据目录>/companion/groups/<chatKey>/`（`MEMORY.md` + `notes/`）：每个群独立的长期记忆，群聊回合默认只注入公开 `ROLE.md` + 本群记忆，绝不自动把 `private/` 注入公司群（若 Owner 明确希望某群共享全部私聊记忆，须按群显式开启并展示风险提示）。
  - 多任务并行直接由 T3 原生多 Thread 编排承担，不再复制 Mingle 针对单会话设计的 `lines.ts`。

### 5. 第一版群聊开放下的安全模型

第一版**开放私聊与已放行群聊 `@机器人`**。经 Owner 放行的群（或开启同组织自动放行后），群内已放行成员 `@机器人` 均可使用助手的完整任务协作能力；安全边界必须在**服务端回合上下文、Provider 原生工具层、T3 MCP 层和记忆写入路径**全链路落硬门禁，不能仅靠提示词：

1. **回合级可信执行上下文与受众会话隔离（Turn Execution Context）**：
   - 服务端必须为**每一个回合（turn）**不可变地绑定 `{ source: "desktop" | "im", connectionId, chatId, chatKind: "dm" | "group" | "thread", senderRole: "owner" | "member", replyAudience: "local_only" | "owner_dm" | "group" }`，并透传至 Provider 权限钩子与 MCP 工具上下文。
   - **严格按受众隔离 Thread 历史与 Provider 会话（防窄受众泄露到宽受众）**：**同一个 Provider 会话和 Thread 历史绝不混用 `local_only`/`owner_dm` 与 `group` 受众**。用户在桌面打开某条群任务 Thread 继续私有对话时，服务端默认从该节点**派生（fork）一条新的本地私有 Thread**（`replyAudience = local_only`），不向原群 Thread 和群 Provider 会话写入桌面私聊与私有工具结果，防止后续群友在原群追问时从会话历史套出桌面私有内容；若用户显式选择在桌面“回复到该群”，则该发言按 `group` 受众约束执行。
   - **Owner 在群里发言同样受群受众约束**：只要 `replyAudience === "group"`，回复全群可见，默认保护 Owner 私有数据不自动外泄到群内。
2. **数据与工具的双层硬边界（Provider 原生工具 + T3 MCP）**：
   - **独立任务目录 + Provider 原生工具拦截（适用于所有 IM 来源回合及群受众回合）**：锁定版 Pi 的 Supervised 模式默认放行只读原生工具 `read` / `grep` / `find` / `ls`（`t3code@3ce2145:packages/provider-pi/src/server/mcpExtensionSource.ts:363`），且免项目 Thread 可能共用 `scratch/`。因此：
     - 每个 IM 任务/会话分配**独立隔离工作目录**（`<数据目录>/im/workspaces/<scope>/<threadId>/`），不共享桌面 `scratch/`；
     - 在随包 Pi 的权限钩子层，对**所有 IM 来源回合（含 Owner 私聊与群聊）以及所有 `replyAudience === "group"` 的回合（含用户在桌面显式回复到群）**的原生 `read` / `grep` / `find` / `ls` / `write` / `edit` / `bash` 强制校验路径：任何触及隔离工作目录之外的读写搜索，以及所有 `bash` / 命令执行，一律挂起等待 Owner 单次批准（取消对目录外只读工具的自动放行，防止私聊、群聊或桌面群回复意外读出本机敏感文件并外发）；
     - 开发者模式下其他 Provider（Claude Code / Codex / OpenCode 等）仅在其适配层具备同等工作目录隔离与原生工具审批边界后，才允许承接 IM 路由。
   - **私有插件资源与群共享资源隔离（补齐 `todo` / `calendar` / `obsidian` 缺口）**：
     - 现有内置待办工具（包括 `todo__list`、`todo__delete`）的 `confirm` 均为 `false`。若不区分作用域，群聊回合可直接读出或删除 Owner 私有待办并在群里输出摘要。
     - 服务端与插件桥按作用域区分 **Owner 私有记录**（现有及桌面/私聊创建的待办、日程、Obsidian 笔记）与 **群共享记录**（按 `chatKey` 隔离）：
       - **Owner 私聊（`replyAudience === "owner_dm"`）**：可按桌面插件规则正常读写 Owner 私有待办/日程/已授权笔记（其中声明 `confirm: true` 的破坏性写操作仍需批准）；
       - **群受众回合（`replyAudience === "group"`，含 Owner 本人在群内发言）**：可完整读写本群共享记录；任何读取、摘要外发或修改/删除 Owner 私有记录，以及跨聊天主动发消息、外发本地私有文件、执行 `confirm: true` 破坏性写入，一律挂起等待 Owner 单次批准。
   - **单次绑定审批（仅 Owner 可批）**：
     - 每次 `request.pending` 审批严格绑定 `(turnId, toolName, normalizedArgsHash, replyAudience)` 且**仅单次生效**（IM 混合回合禁用“本会话允许”）；
     - 首版统一回桌面原生审批（唯一批准主体为本机 Owner）；后续按 `Q-09` 开放 IM 互动卡片审批时，连接器强制核验点击者 `senderId === connection.ownerId`，且与桌面并发操作仅首次生效。
   - **管理类操作仅限 Owner**：`/stop`、暂停、放行/拒绝群与联系人、关联 Owner 账号、管理连接与凭据仅允许 Owner 执行。
3. **提示词注入四层纵深防御**：
   - **L1 结构化不可信数据信封**：所有 IM 入站正文、群背景、引用内容、昵称、文件名和备注在进入模型前统一包裹在显式不可信边界中（转义闭合标签，并由服务端注入可信 `senderRole` 与 `chatKind` 元数据），明确声明信封内文本为数据而非指令覆盖。
   - **L2 代码层硬闸门**：上述 Provider 原生工具钩子、T3 MCP 作用域校验、单次审批与访问门禁全部在代码层强制裁决，不依赖模型自律。
   - **L3 全路径防持久化记忆投毒**：任何从群聊回合写入 `ROLE.md`、`companion/private/` 或公共记忆的路径——包括文件写工具、记忆 MCP 工具、以及后续 `tidy` 整理任务和 Owner 在群内触发的回合——均按“来源作用域 → 目标作用域”执行跨范围写校验，跨范围写入一律需 Owner 单次审批，彻底封死通过 `notes/` 或 `tidy` 污染 Owner 私聊记忆的路径。
   - **L4 严格凭据安全（移除明文回退）**：在 vendoring Mingle `secrets.ts` 时**明确移除 Linux/通用环境的明文 `0600` 文件回退（`fileSecrets`）**；操作系统安全凭据存储（macOS Keychain `security -i` / Windows DPAPI / Linux Secret Service）不可用或写入校验失败时直接阻止绑定并向用户说明原因。IM 凭据、模型网关令牌和 T3 MCP 令牌进程级隔离，绝不进入模型环境、SQLite、日志或 HTTP 响应。

## Invariants

1. T3 服务端是对话持久化、Provider 编排、MCP 工具与审批状态的唯一事实来源；`im-bridge` 不维护第二套 Agent 运行时或第二套业务插件数据。
2. `moejs` 插件沙箱继续保持零网络、零原始文件系统、零进程和零凭据边界。
3. 未绑定任何 IM 且不在临时 `pairing` 态时，`im-bridge` 零外网长连接、零后台轮询、零系统隐私权限弹窗。
4. 未发给机器人的群背景消息与可选旁听评估绝不创建 T3 Thread 或污染桌面侧栏；未放行或已拒绝的群/联系人不入背景检索。
5. 每个回合在服务端绑定不可变的 `TurnExecutionContext`，并按受众严格隔离历史与 Provider 会话（桌面私有续聊从群 Thread 派生独立本地 Thread，绝不把 `local_only`/`owner_dm` 历史混入 `group` 会话）；所有 IM 来源回合及 `replyAudience === "group"` 回合（含桌面显式回复到群）的隔离目录外原生读写搜索与 `bash`、群受众对 Owner 私有插件数据的读写，以及跨范围记忆写入，均需 Owner 单次绑定审批。
6. 所有 IM 凭据仅存操作系统安全凭据库，无明文文件回退，绝不进入模型上下文、SQLite、日志或 HTTP 响应。
7. 同一外部消息在落盘与投递链路全程受端到端幂等键保护（重启只补投已通过门禁且未确认的 `received` / `delivered` 触发记录），保证最多创建一个 T3 回合；执行中途崩溃的回合重启后不自动盲重跑，防止工具重复写入。

## Consequences and Trade-offs

- **收益**：复用 Mingle 经实战打磨的 `Channel` 抽象、扫码接入、状态机与安全凭据封装，大幅缩短 M4 周期；同时拥有 Xtwork 统一桌面对话、内置 Pi、共享插件数据和 Mingle 的伴侣体验，补齐了 Mingle 原版在群聊审批、只读越界、私有数据隔离和跨群记忆投毒上的安全缺口，且不破坏上游 T3 升级路径。
- **代价**：需要在 `im-bridge/` 维护一份独立锁定的 Node 包与 MIT 第三方声明，改造随包 Pi 的目录外只读权限钩子与插件作用域隔离，并由我们自己完成企业微信与个人微信 iLink 的真机端到端验收。
- **待验证项**：企业微信 9 分钟流式窗口切换与多端挤占行为；个人微信 iLink 真机扫码、实名/PIN、先落库后提交游标、主动发送及分发合规边界；飞书最小权限首通与二次扫码补权；随包 Pi 原生只读工具目录隔离钩子实测；以及无全局 Node 干净机器上的安装包启动、握手与退出无残留验收。

## Migration Implications

- 新增 `<数据目录>/im/`（`im-bridge` 的轻量 SQLite、隔离任务工作目录 `workspaces/` 与日志）及 `<数据目录>/companion/`（`ROLE.md`、`private/`、`groups/`）；不修改已有 `userdata/statev2.sqlite` 和 `userdata/plugins/todo/storage.json` 的读取兼容性，既有待办记录默认归属 Owner 私有作用域。
- 上游 T3 仅增加极薄的服务层、路由与随包 Pi 权限钩子补丁，不修改 T3 `contracts` RPC 和 `pnpm-lock.yaml`。
- `scripts/build-desktop.mjs` 增加 `im-bridge/` 依赖锁定安装、打包拷贝、`THIRD_PARTY_NOTICES` 归属以及无全局 Node 的包内启动/退出冒烟检查；`shell/config.go` 增加向 T3 传入 `XTWORK_IM_BRIDGE_ENTRY` 等绝对路径配置。

## Related Decisions

- [决策索引](../../DECISIONS.md)
- [ADR-001 · 桌面架构](001-desktop-architecture.md)
- [ADR-003 · 内置插件与共享上下文](003-bundled-plugins.md)
- [ADR-006 · 上游同步策略](006-upstream-update-policy.md)
- [ADR-007 · 插件通信、授权与持久化边界](007-plugin-contract.md)
- [ADR-009 · 默认内置运行时 Pi](009-default-pi-runtime.md)
- [ADR-010 · 插件 v2 双轨运行时与模态承载](010-plugin-v2-runtime.md)
- [ADR-013 · Leader（Captain 式主管实体）、侧栏置顶入口与 Mingle 能力移植边界](013-leader-supervisory-threads.md)
- [07 远程连接插件](../plan/07-远程连接插件.md)
