# Dim ACP flavor 待办

> **历史记录（2026-11-20 归档）。** Dim 方向已被 Pi 方案替代。下文保留原先的决策、调研和未执行的验收。现行设计见 [03 内置运行时 · Pi](03-内置运行时-Pi.md) 和 [ADR-009](../decisions/009-default-pi-runtime.md)。

> 目标是让 bundled Dim 复用 T3 的统一 Timeline，同时保留 ACP 通用适配的升级边界。
> 当前设计已经通过 Astra 与 Gemini 4 Neon 的独立评审。实现前置条件如下。

## 共识方案

- 继续使用 T3 的 `AcpAdapterV2Flavor`。
- 新增独立的 `dimAcp.ts` 和 `031-dim-acp-flavor.patch`。
- bundled Dim 使用三元门控：`source: local`、实例 ID `xtworkDim`、环境 marker `XTWORK_DIM_ACP_FLAVOR=1`。
- `mcpOverHttp: true` 作为 Dim 的明确传输配置。
- 第一阶段不写 Dim native adapter，不接 Dim 私有 App Server RPC，不修改 React Timeline。
- Plan、MCP Apps 和原生子代理 lineage 延后到真实协议能力具备后再开放。

## P0 实现前置项

### ACP flavor 和门控

- [ ] 在 `runtime/gateway.ts` 注入非敏感的 `XTWORK_DIM_ACP_FLAVOR=1`。
- [ ] 新增 `overlay/files/packages/provider-acp-registry/src/server/dimAcp.ts`。
- [ ] 新增 `overlay/patches/031-dim-acp-flavor.patch`。
- [ ] 只对 `source: local`、`xtworkDim` 和 marker 同时匹配的实例启用 flavor。
- [ ] marker 只作为路由开关，不能当作安全边界。
- [ ] 定义门控优先级、启动诊断和 fail-closed 行为。
- [ ] 为 patch 写上游版本锚点、删除条件、幂等应用和回滚说明。

### Capability negotiation

- [ ] 显式关闭 Dim alpha.25 尚未提供的 `planning.emitsPlanUpdated`、`planning.emitsTodoList` 和 `planning.emitsProposedPlan`。
- [ ] 不开启 `reportsPerTurnPromptUsage`。Dim 当前通过 `usage_update` 上报上下文用量。
- [ ] 明确 ACP v1 回退规则。Dim 直接收到 ACP v2 初始化时会失败，必须验证 T3 的协商回退。
- [ ] 未知能力默认关闭，避免 UI 显示空计划卡或错误交互。
- [ ] 记录每次 session 初始化的实际能力，便于升级后诊断。

### 工具和后台任务

- [ ] `normalizeToolCall` 保留 `rawInput`、`rawOutput`、`content` 和 metadata。
- [ ] 只根据明确字段分类 `execute`、`read`、`search`、`fetch`、`edit`、`delete`、`move`。
- [ ] 未知工具保持 `other`。
- [ ] 规范化时同步更新 `kind`、`data.kind`、`title` 和 `command`。
- [ ] 处理 Dim 后台任务的双 `toolCallId`，明确发起工具、`["background", taskId]` 和 `wait`/`exec_stop` 的单一归属规则。
- [ ] 接入 `extractBackgroundTaskId`、`extractBackgroundTaskCompletion` 和必要的持久后台任务 hook。
- [ ] 验证回合结束后后台任务继续运行时是否需要 `deferFinalizeForBackgroundWork` 或 `enablePostSettleContinuation`。

### Compaction

- [ ] 增加 `normalizeSessionUpdate`。
- [ ] 将 `_meta.lody.activity.kind === "context_compaction"` 转成标准 `compaction_update`。
- [ ] 保留 `usedTokensBefore`、`usedTokensAfter`、诊断信息和失败原因。
- [ ] 保持原始 `toolCallId` 不变，避免破坏 T3 的工具合并和 compaction 识别。
- [ ] 覆盖成功、失败和取消三种压缩终态。成功态需要真实录制确认。

### 权限、问答和取消

- [ ] 增加 `extractElicitationForm`，把 Dim 的 `q{n}` 和 `custom{n}` 折叠成一题。
- [ ] 覆盖单选、多选、自定义文本、取消、重复回答和迟到回答。
- [ ] 映射 T3 权限模式到 Dim 的 `read-only`、`workspace-write`、`full-access`。
- [ ] `approval-required` 和 `auto-accept-edits` 默认使用 `workspace-write`，避免 `read-only` 让插件工具全部不可用。
- [ ] 识别 `Command cancelled.` 等取消输出，确保工具显示 interrupted，不显示普通失败。
- [ ] 为权限请求、问答和取消建立明确状态机，规定重复终态和竞态处理。

### HTTP MCP

- [ ] 使用 `mcpOverHttp: true`，并用真实 bundled Dim 验证 `initialize`、`tools/list`、`tools/call`。
- [ ] 验证 `mcp_temporary_*` 工具名哈希化不会破坏插件调用、重试幂等和确认条。
- [ ] 记录无法从哈希反解原工具名的限制，未知 MCP 工具保持 `other`。
- [ ] 确认第一帧 `rawInput: null`、后续更新缺少 `name/title` 时，合并后的 `data.name` 和 `data.title` 仍能正确显示。

### 会话和用量

- [ ] 明确 `usage_update` 的累计值、缺字段和非法数字处理。
- [ ] 验证 `session/load`、`session/resume` 的统一 native session identity。
- [ ] 覆盖长会话分页、服务端重启、HTTP MCP 重挂载和重复恢复。
- [ ] 验证取消、失败、退出后的 session 终态幂等。

## P1 测试和回归

### 真实协议录制

- [ ] 用锁定的 Dim `v0.1.0-alpha.25` 二进制录制 ACP 初始化、建会话、提示、工具、权限、问答、用量、压缩、取消、加载和恢复。
- [ ] 录制使用本地 mock OpenAI SSE 和 mock HTTP MCP，保证可重复且不依赖线上额度。
- [ ] 记录 Dim SHA、T3 commit、model config、工作目录和协议版本。
- [ ] fixture 可脱敏、可重复、完整消费所有 ACP 帧。

### Replay fixture

- [ ] 文本和思考增量保持顺序，终态不重复。
- [ ] 工具覆盖 pending、running、completed、failed、cancelled 和未知字段。
- [ ] 后台任务覆盖启动、迟到完成、失败、取消和主回合先结束。
- [ ] compaction 覆盖成功、失败和取消。
- [ ] 权限和 elicitation 覆盖允许、拒绝、取消、重复和迟到回答。
- [ ] replay 覆盖未知、重复、乱序、失败和中断事件。
- [ ] MCP HTTP fixture 覆盖工具名哈希、权限请求、重试和幂等键。

### 构建门槛

- [ ] 在 `.build/t3code` 内运行 `@t3tools/provider-acp-registry` 的 typecheck。
- [ ] 运行 `@t3tools/provider-acp-registry` 的测试。
- [ ] 运行 apps/server 类型检查和受影响测试。
- [ ] 运行现有 `runtime/smoke-t3.mjs`，确认待办创建、重启读取和 Dim 退出仍通过。
- [ ] 验证普通 ACP provider 不受 Dim flavor 影响。

## P2 能力门槛

### Plan

- [ ] 只有真实收到 `plan`、`plan_update`、`plan_removed` 并有 replay fixture 后，才重新开放 planning capability。
- [ ] 计划卡必须覆盖增量、删除、失败、取消和恢复。

### MCP Apps

- [ ] Dim daemon 保留工具 `_meta.ui.resourceUri`。
- [ ] Dim 支持 `resources/read`。
- [ ] ACP flavor 能生成 T3 `McpAppReference`。
- [ ] `McpAppFrame` 能加载、交互、断线恢复和安全退出。
- [ ] 资源大小、CSP、权限和 view call 单独验收。

## 发布前检查

- [ ] `docs/dim-acp-flavor.md` 记录最终字段映射、能力矩阵和版本边界。
- [ ] [里程碑与验收](10-里程碑与验收.md) 加入 flavor 的 P0/P1/P2 验收。
- [ ] [风险与待定](11-风险与待定.md) 删除已验证项，保留真实未决项。
- [ ] 生成包确认 marker 只注入 bundled Dim，settings.json 不持久化 marker。
- [ ] 升级 Dim 后重新录制 capability matrix 和关键 replay fixture。

## 完成条件

P0 全部通过后，Dim ACP flavor 才能进入桌面预览。P1 全部通过后，才把工具分类、后台任务和压缩体验作为稳定能力发布。P2 通过前，Plan 和 MCP Apps 保持关闭并显示普通工具 fallback。
