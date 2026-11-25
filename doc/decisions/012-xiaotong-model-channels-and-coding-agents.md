# ADR-012 · M1 重构：内置助手「小瞳」、多渠道模型平面、六大编码 Agent 一键安装与 Coding Agent 委派

- **Date** 2026-11-25
- **Status** Accepted（演进并细化 [ADR-004](004-general-task-experience.md)、[ADR-008](008-model-gateway.md)、[ADR-009](009-default-pi-runtime.md)，协同 [ADR-011](011-mingle-im-bridge.md)）
- **Evidence** Confirmed · 2026-11-25 项目负责人确认采用「小瞳」命名并批准本方案；代码约束核对自 Electron 版 [`xiaotong_work`](file:///Users/mizu/Downloads/02-Projects/xiaotong_work)（Pi `0.87.1`）、锁定上游 `t3code@3ce21458`、随包 Pi `1.5.2` 及官方 ACP Registry（`v1.0.0`），并经 Claude Opus 5.5 架构审查修订定稿。

> **证据分层约定**：文中引用的供应商契约与 OIDC 协议来自 Electron 版 `xiaotong_work`（Pi `0.87.1`）；T3/Pi 约束经 `t3code@3ce21458` 与随包 Pi `1.5.2` 源码静态核实；六款外部编码 Agent 的官方安装命令、`dsh --profile acp` 真实行为及新链路端到端表现均属**待实跑验证项**，验收通过前不计入已确认能力。

## Context

在 [PR #19](https://github.com/oulkurt/Xtwork-v2/pull/19) 与 [PR #20](https://github.com/oulkurt/Xtwork-v2/pull/20) 落地后，M1 桌面版已完成默认简体中文（`zh`/`en` 双语）、普通模式内置浏览器（`ServerBrowser`）、免项目草稿与开发者功能开关。但既有 M1 规划（[ADR-004](004-general-task-experience.md)、[ADR-008](008-model-gateway.md)、[ADR-009](009-default-pi-runtime.md)）存在三处与实际使用场景不匹配的收敛假设：

1. **内置助手命名与模型供给过窄**：随包 Pi 实例（`xtworkPi`）目前命名为「内置助手」，仅通过单路由本机代理（`runtime/gateway.ts` 的 `POST /v1/chat/completions` + 固定启动参数 `--provider xtwork --model standard`）暴露单个 `xtwork/standard` 模型，尚不支持团队成员已习惯的企业微信公司渠道登录与多模型供应商自带 Key / 订阅登录。参考 Electron 版 [`xiaotong_work`](file:///Users/mizu/Downloads/02-Projects/xiaotong_work)，成员生产环境已使用：
   - **公司团队渠道（`xiaotong-work-team`）**：Keycloak OIDC + PKCE（`S256`，`kc_idp_hint=wecom-web`）企业微信扫码登录 → JWKS 校验 `id_token` → `/api/oauth/exchange/keycloak` 换取个人长效 `sk-` Key → 同步 `/v1/models`（默认 `deepseek-flash` 等）；
   - **19 类成员渠道（`ProviderType`）**：覆盖 Anthropic、OpenAI、OpenAI Responses 格式、ChatGPT 订阅（Codex）、GitHub Copilot 订阅、xAI 订阅（Grok）、DeepSeek、Google、Kimi API、Kimi Coding Plan、智谱 AI、智谱 Coding Plan、智谱 Coding Plan 团队版、火山引擎 API、MiniMax（API & 编程包）、通义千问、通义千问 Token Plan、小米 MiMo（API）、小米 MiMo Token Plan（以及自定义兼容端点）。
2. **外部编码 Provider 被开发者开关隐藏且缺少开箱安装体验**：当前实现在普通模式下隐藏了 `/settings/providers` 及全部外部 Provider。实际用户希望直接看到并选用 **Claude Code、Codex、Kimi Code、Qoder、Codebuddy Code、DeepSeek Harness**，并在未安装时点击「一键安装」按官方命令完成安装。
3. **缺少「对话中由小瞳将编码任务委派给指定 Coding Agent」的路由能力**：用户希望日常对话默认留在内置助手「小瞳」（运行在当前选定的公司或个人模型上），同时可在设置中指定 **Coding Agent**（默认「自动」= 使用内置小瞳当前模型；或指定为 Claude Code / Codex / Kimi Code / Qoder / Codebuddy Code / DeepSeek Harness 等外部 Agent），遇到编码任务时交由所选 Coding Agent 执行，而无需手动切换会话或丢失上下文。

## Problem

在同时保留「普通用户开箱即用」与「薄改 T3 Code 上游（[ADR-006](006-upstream-update-policy.md)）」的前提下，必须闭合七个架构与执行合同问题：

1. **双平面耦合**：「Provider」在用户语境中同时指代**模型供应商**（服务于小瞳）与**外部 Agent 运行时 / Harness**（自带 Agent 循环、工具集与独立进程）。若不拆层，设置路由、凭据边界、模型选择器与会话归属会产生结构性冲突。
2. **活跃 Pi 会话刷新断层**：T3 的 `ProviderRegistry.refreshInstance` 通过启动新的临时 Pi 发现进程刷新选择器（`packages/provider-pi/src/server/status.ts:140`），但**已启动的活跃 Pi RPC 会话在内存中缓存了启动时的模型快照**（Pi `1.5.2` `rpc-mode.js:387`），`get_available_models` 与 `set_model` 均不重读 `models.json`。仅写配置 + `refreshInstance` 会导致旧会话切到新渠道时报错 `Model not found`。
3. **OAuth 订阅的专用 auth/transport 约束**：随包 Pi `1.5.2` 源码显示，Codex 在联网前会解析令牌中的 `chatgpt_account_id` 且默认优先尝试 WebSocket（`openai-codex-responses.js:170–204,1272`），简单随机十六进制网关令牌无法通过；GitHub Copilot 的 OAuth `toAuth` 会生成凭据相关的 `baseUrl`（`github-copilot.js:377`），若改走普通网关 Key 路径也不会自动继承 OAuth 模型过滤。
4. **干净机器工具链与默认实例缺口**：`scripts/build-desktop.mjs:55–57` 当前仅解出 `bin/node` 与 `LICENSE`，**未随包携带 `npm`/`npx`**；`AcpRegistrySupport.ts:1653–1715` 探测与安装读取的是服务端级 `hostEnvironment` 而非单实例环境；`ProviderInstanceRegistryHydration.ts:70` 会跳过 `hasDefaultInstance === false` 的 `AcpRegistryDriver`，仅恢复页面不会自动出现四张推荐 ACP 卡片。
5. **运行时静默下载与安装器范围**：`AcpRegistrySupport.ts:1904–1921` 的正常 `resolve` 路径会在启动或 Registry 升版时自动下载/安装包；仅在安装按钮前加确认无法阻止运行时静默下载。且现有 `providerInstallation.ts:81–95` 仅支持 Codex/Antigravity，并非通用六 Agent 安装器；任意官方 Shell 脚本也无法无条件承诺应用私有卸载、完整回滚或干净取消。
6. **Coding Agent 委派的执行、工作区与上下文合同**：纯提示词偏好不能保证强制执行；`OrchestratorMcpService.ts:2696–2770` 将本地委派 cwd 限定在父线程所属 project，且 `isolation: "worktree"` 要求有效 Git HEAD（非 Git `scratch/` 不可用）；`Orchestrator.ts:9679–9732` 创建子线程时只传显式 `task` 文本、附件为空，不会自动移交父线程完整历史。
7. **IM 安全继承与 SecretStore 删除语义**：`XtworkImMcp.ts:51–54` 当前 IM MCP 白名单不含 `delegate_task`，且一次“同意启动外部 Agent”无法替代 [ADR-011](011-mingle-im-bridge.md) 要求的逐工具、参数绑定、受众隔离与路径检查。同时 `im-bridge/src/platform/secrets.ts:89–98,161–164,333–336` 当前在 macOS/Linux 上忽略 delete 退出码且将多数读取失败折叠为“不存在”，无法直接兑现“删除失败不宣称退出”。

## Considered Alternatives

### A. 小瞳多供应商模型接入

| 方案 | 概要 | 结论 |
|---|---|---|
| **A1：单协议转译网关（扩展现有 `chat/completions`）** | 所有 19 类供应商全部转译为 OpenAI Chat Completions | **拒绝。** 跨协议转译损失 Anthropic adaptive thinking / cache、OpenAI Responses、Gemini 多模态思考，且无法承载 OAuth 专属协议。 |
| **A2：将明文 Key / OAuth 直接写入 `runtime/pi/models.json` 与 `auth.json`** | 让随包 Pi CLI 直接连接各厂商端点 | **拒绝。** 真实凭据落盘于 Pi 运行目录，破坏“真实凭据绝不进入 Pi”不变量。 |
| **A3（采用）：统一 Proxy-Only 保协议本机反向代理 + 硬化 OS 钥匙串 + 窄 OAuth 传输适配** | 所有 16 类 API 渠道、公司渠道与 3 类 OAuth 订阅渠道**统一坚持 Proxy-Only**：真实 API Key、公司长效 Key、OAuth `access_token` 与 `refresh_token` 均只留在 Xtwork 服务端网关与单一窄 OS SecretStore 中，绝不进入 Pi 内存或磁盘；对 Codex / Copilot / xAI 增加窄的 gateway-aware auth/transport 适配（见 §3.4） | **采用。** 保持单一、无矛盾的凭据隔离不变量，同时完整保留 4 种原生线协议与 OAuth 订阅特性。 |

### B. 六大外部编码 Agent 接入与一键安装

| 方案 | 概要 | 结论 |
|---|---|---|
| **B1：为每个编码 Agent 编写独立 T3 Provider Driver** | 自研 Kimi / Qoder / Codebuddy / DeepSeek 四个原生驱动 | **拒绝。** 上游 T3 维护成本高，且官方 ACP Registry (`v1.0.0`) 已收录 `kimi-code`、`qoder`、`codebuddy-code`（T3 已内置 `kimiAcp.ts`）。 |
| **B2（采用）：复用 T3 原生驱动 + 官方 ACP Registry + 本地 ACP 模板 + 服务端统一安装授权门禁** | Claude Code 用 `ClaudeDriver`；Codex 用 `CodexDriver`（复用 `CodexInstallation`）；Kimi Code / Qoder / Codebuddy Code 用 `AcpRegistryDriver`（`source: "registry"`）；DeepSeek Harness 用 `AcpRegistryDriver`（`source: "local"`，`dsh --profile acp`）；补齐随包 npm、服务级 `hostEnvironment`、4 个稳定种子实例与服务端统一 consent gate | **采用。** 最大化复用上游 T3 代码，堵住运行时静默下载漏洞。 |

### C. Coding Agent 委派机制

| 方案 | 概要 | 结论 |
|---|---|---|
| **C1：在 Pi 内新增独立子进程编码工具（绕开 T3 编排）** | 由 Pi 扩展直接 spawn 外部编码 CLI | **拒绝。** 形成双轨编排，丢失 T3 子任务卡片、权限审批流、递归取消与持久化。 |
| **C2（采用）：复用 T3 `orchestration-v2` + `OrchestratorMcpService` (`delegate_task`) + 明确路由/工作区/上下文合同** | 通过服务端可校验的设置项驱动小瞳调用 `delegate_task`，补齐强制预检、工作区规则、结构化交接简报与复用父级递归停止（`ThreadManagementService.ts:1612–1670`）；IM/群聊首版硬拒绝外部委派 | **采用。** 单一编排内核，合同清晰且严格守住 ADR-011 红线。 |

## Decision

### 1. 架构分层：严格拆分「模型平面（Model Plane）」与「运行时平面（Harness Plane）」

```text
用户界面（设置 / 对话输入框）
  ├─ 模型平面（归属内置助手「小瞳」xtworkPi）
  │    ├─ 公司团队渠道（企业微信 OIDC+PKCE → 个人长效 Key，不可编辑/不可删除）
  │    ├─ 16 类成员 API 渠道（4 种原生线协议：OpenAI Chat / OpenAI Responses / Anthropic Messages / Google GenAI）
  │    └─ 3 类成员 OAuth 订阅渠道（ChatGPT Codex / GitHub Copilot / xAI Grok，Proxy-Only 窄适配）
  │         └─ 全部真实凭据仅存单一硬化 OS SecretStore → 本机保协议网关注入 → 随包 Pi（仅持单次启动网关令牌）
  │
  ├─ 运行时平面（外部编码 Harness，普通模式可见 + 受控一键安装）
  │    ├─ 原生驱动：Claude Code (`claudeAgent`)、Codex (`codex`)
  │    ├─ 官方 ACP Registry 种子实例：Kimi Code、Qoder、Codebuddy Code
  │    └─ 本地 ACP 种子实例：DeepSeek Harness (`dsh --profile acp`)
  │
  └─ 委派路由层（Coding Agent 设置，默认「自动」）
       └─ 自动 = 小瞳直接执行；指定外部 Agent = 经 T3 `delegate_task` 按执行与上下文合同委派（IM/群聊首版硬拒绝）
```

### 2. 内置助手更名、稳定模型 ID 与零渠道边界

- **更名与平滑迁移**：将 `runtime/bundledPiSettings.ts` 中 `xtworkPi` 的默认 `displayName` 由「内置助手」改为「**小瞳**」；升级时仅将仍为旧默认值「内置助手」的配置迁为「小瞳」，保留用户自定义名称。
- **稳定模型身份（支持同厂商多账号）**：移除 `runtime/gateway.ts:169–175` 中写死的 `--provider xtwork --model standard` 强绑定，改为按**渠道实例 ID 命名空间**暴露稳定模型 ID（如 `<channelId>/<modelId>`，公司渠道固定为 `xiaotong-work-team/<modelId>`，预览开发兜底保留 `xtwork/standard`），确保用户同时配置多个同厂商账号（如两个 OpenAI 或两个 Anthropic Key）时不会互相覆盖。
- **零渠道与末渠道删除**：
  - 首次未登录公司渠道、未配置个人渠道且未设置开发测试环境变量时，`xtworkPi` 仍以“待配置模型”态清晰引导用户去企业微信扫码登录或添加渠道，而不因 `--model` 缺失导致 Pi 启动崩溃；
  - 删除或禁用当前选中的渠道/模型时，服务端与前端平滑回落到下一个已启用默认模型（优先公司渠道 `deepseek-flash`，否则首个可用成员模型；均无则进入待配置引导态），且**网关强制校验渠道启用状态与模型启用白名单**，拒绝已禁用渠道/模型的请求。

### 3. 「小瞳」的模型平面：公司企业微信渠道 + 19 类成员供应商

#### 3.1 单一硬化 OS SecretStore（禁止长出多套 Vault）

- **不引入三套凭据库**：不复用仅服务于 Electron 浏览器导入的 `@napi-rs/keyring`（`ChromiumKeys.ts:52–69`），也不使用单项上限仅 2560 字节的 `mygo.Secrets`（`mygo@v0.10.0/secrets.go:54–58`），且绝不向 WebView 暴露通用取密钥接口。
- **抽离并硬化单一共享 OS SecretStore 模块**（供 `im-bridge` 与模型渠道管理器以独立命名空间 factory 共用：`app.xtwork.im-bridge` / `app.xtwork.model-channels`），开工前必须先补齐以下四项：
  1. 区分 `missing`（条目确实不存在）、`unavailable`（钥匙串/DPAPI/Secret Service 不可用）与 `denied`（用户拒绝/权限不足），禁止将任意非零错误折叠为 `undefined`；
  2. `delete` 必须检查命令退出码并回读确认为 `missing`，删除失败时抛错，绝不宣称已退出；
  3. 保持 fail-closed（零明文文件回退），写入后回读校验；
  4. 增加**并发代际锁 / 栅栏（fencing token）**：退出登录或删除渠道时递增代际号并中止进行中的 OAuth 刷新，防止在途 refresh 完成后把旧凭据重新写回钥匙串。
- **安全边界准确表述**：OS 钥匙串隔离与 `pi-shell` 环境变量剥离旨在防止明文落盘与进程意外继承，**不等同于针对同 UID 下任意用户批准 Bash 命令的 OS 强沙箱**。
- 渠道元数据保存于 `<数据目录>/channels/channels.json`（权限 `0600`），**不含任何明文凭据**；前端仅获脱敏状态。

#### 3.2 公司团队渠道（对齐 `xiaotong_work` `company-oauth.ts` & `company-auth-service.ts`）

- **认证契约**：复用既有 Keycloak OIDC + PKCE（`S256`、`issuer = https://llm-api.sci-it.com/keycloak/realms/sci-it`、`client_id = xiaotong-work`、`kc_idp_hint = wecom-web`、`prompt = login`、`state` + `nonce`）、JWKS `RS256` 签名与 `iss`/`aud`/`azp`/`nonce` 校验，以及 `POST https://llm-api.sci-it.com/api/oauth/exchange/keycloak` 换取个人长效 `sk-` Key 与 `member` 信息。
- **本机回调监听**：登录开始时仅绑定 `127.0.0.1:49160` 与 `[::1]:49160`（生产注册回调 `http://localhost:49160/callback`），校验 `Host`、`state`、`code` 唯一性，响应 `no-store` / `no-referrer` / nonce CSP 并通过 `history.replaceState` 清洗地址栏，随后立即关闭监听；端口被占用（如与旧 Electron 版并发登录）时返回明确中文提示。通过 `window.desktopBridge.openExternal` 打开系统浏览器，回调后调 `revealWindow` 唤回窗口。
- **团队渠道语义与注销边界**：
  - 固定渠道 ID `xiaotong-work-team`（`https://llm-api.sci-it.com/v1`，`openai-completions`），仅在已登录（存在 `member`）时暴露模型；登录后同步 `GET /v1/models`，默认优先选中 `deepseek-flash`；成员仅可启停渠道和勾选模型，不可改地址/凭据或删除；
  - 退出登录先执行**经回读验证的本地密钥删除**（删除失败则保留登录态并报错），清空内存 Key 与模型暴露，再尽力调用 Keycloak `/protocol/openid-connect/revoke` 撤销 `refresh_token`。**文档与界面需准确说明**：本地退出立即终止本机调用并尝试撤销 OIDC `refresh_token`，但不等同于在服务端注销由 `new-api` 管理员签发的个人长效 `sk-` Key。

#### 3.3 版本化供应商能力矩阵（19 类成员渠道）

以 Electron 版 `xiaotong_work`（Pi `0.87.1`）的供应商契约与回归用例为参考基线，针对 v2 锁定的 **Pi `1.5.2`** 建立独立版本化能力矩阵（逐项标注「Electron 已验证 / Pi 1.5.2 静态核实 / v2 新链路待实跑」，不逐行盲搬旧 adapter）：

| 协议族 | 对应供应商 | 关键协议/能力契约 |
|---|---|---|
| **`anthropic-messages`** | Anthropic、Anthropic 兼容格式、DeepSeek (`api.deepseek.com/anthropic`)、Kimi API (`api.moonshot.cn/anthropic`)、Kimi Coding Plan (`api.kimi.com/coding/v1`)、智谱 Coding Plan / 团队版 (`open.bigmodel.cn/api/anthropic`)、MiniMax (`api.minimaxi.com/anthropic`)、通义千问 Token Plan (`.../apps/anthropic/v1/messages`)、小米 MiMo (API) / Token Plan | 网关按供应商区分 `x-api-key` 与 Bearer-only 认证；Coding/Token Plan 注入合规 `User-Agent`；智谱团队版解析复合凭据（`apiKey; organization; project`）；Claude 启用 `forceAdaptiveThinking`；DeepSeek V4 Anthropic 端点在网关侧改写为 `thinking: enabled` + `output_config.effort`；剥离历史 `[1m]` 后缀。 |
| **`openai-completions`** | OpenAI (`api.openai.com/v1`)、智谱 AI (`open.bigmodel.cn/api/paas/v4`)、火山引擎 API (`ark.cn-beijing.volces.com/api/v3`)、通义千问 (`dashscope.aliyuncs.com/compatible-mode/v1`)、自定义 OpenAI Chat Completions、以及公司团队渠道 | 编译 `compat`（`supportsDeveloperRole`、`supportsReasoningEffort`、`thinkingFormat: 'deepseek' \| 'zai'`、`zaiToolStream`）与上下文/最大输出（如 GLM-5.3 128K、MiMo V2.6 128K、DeepSeek Flash 视觉支持）。 |
| **`openai-responses`** | OpenAI Responses 格式 (`api.openai.com/v1`) | 原生透传 `/responses` SSE 流与 reasoning items。 |
| **`google-generative-ai`** | Google (`generativelanguage.googleapis.com`) | 自动补全 `/v1beta` 路径前缀，保留自定义代理路径与 query，校正 Gemini `thinkingLevels`。 |
| **OAuth 订阅渠道（3 类，Proxy-Only）** | ChatGPT 订阅 (Codex)、GitHub Copilot 订阅、xAI 订阅 (Grok) | 浏览器 OAuth 或 RFC 8628 Device Code + 二维码；服务端 60s 提前续期 + 单飞串行刷新锁（受登出代际栅栏保护）；网关侧强制执行 Copilot `availableModelIds` 组织过滤，支持 Codex / Copilot 订阅窗口额度查询。 |

#### 3.4 保协议网关、OAuth 窄传输适配与活跃 Pi 会话热刷新（闭合 Gap 1 & Gap 2）

1. **统一 Proxy-Only 边界（不接受真实 OAuth `access_token` 进入 Pi 内存）**：
   - 本机 loopback 网关（`127.0.0.1:<随机端口>`）按 `/c/<channelId>/<apiKind>/*` 透传 4 种原生 HTTP/SSE 协议，校验单次启动随机令牌 `XTWORK_MODEL_GATEWAY_TOKEN` 与渠道/模型启用白名单，注入真实上游凭据与厂商请求头，并随下游断开取消上游请求；
   - **OAuth 窄 auth/transport 适配（M1b Gate 1 必过探针）**：针对随包 Pi `1.5.2` 已静态核实的传输约束，明确设计网关感知适配而非简单替换 `baseUrl`：
     - **Codex（`openai-codex-responses`）**：在 `models.json` / 随包薄扩展中走 HTTP/SSE 路径直连本机网关（或在网关支持 WS 透传，优先选择确定性更高的 HTTP/SSE 路径并由 M1b Gate 1 实跑验证），并向 Pi 提供**不含任何真实密文的占位 JWT 形状令牌**（仅承载非敏感 `chatgpt_account_id` 占位字段以满足 Pi 联网前解析）或通过薄网关传输适配层绕过客户端侧 JWT 解析，真实 OAuth Bearer 与 `chatgpt-account-id` 仅在本机网关注入；
     - **GitHub Copilot**：明确采用与本机网关匹配的协议路径，禁用/覆写客户端 `toAuth` 对 `baseUrl` 的改写，由服务端在同步与网关转发双处强制执行 `availableModelIds` 订阅/组织过滤，并在网关侧自动完成 Copilot token 续签与头注入；
     - **xAI 订阅**：在服务端完成 device-code 登录与单飞串行刷新，通过本机网关按 xAI 订阅实际协议转发，真实 token 绝不落盘于 `runtime/pi/` 或进入 Pi 内存。
2. **活跃 Pi 会话热刷新合同（闭合 `rpc-mode.js:387` 内存快照断层）**：
   - 仅重写 `runtime/pi/models.json` + 调用 `ProviderRegistry.refreshInstance(xtworkPi)` 只会刷新前端模型选择器，**不会更新已在运行的 Pi RPC 进程内存快照**。
   - **选定机制（M1b Gate 1 必过探针二选一并锁定）**：
     - **首选**：在随包受信 Pi 扩展（如与 `pi-t3-mcp-extension` 并行加载的内置 `xtwork-runtime-refresh` 扩展）中提供**可等待的 `reload_models` 命令/RPC**，渠道变更写完 `models.json` 后，T3 服务端通知全部活跃 `xtworkPi` 会话原子重载内存 `ModelRegistry`；
     - **备选（若 Pi `1.5.2` RPC 层不允许运行中热替换 `ModelRegistry`）**：在服务端记录渠道配置版本号（`catalogRevision`），对已有活跃会话在**空闲/回合边界**按需执行受控进程重建并复用原生 `sessionFile` 恢复续聊（流式进行中的回合绝不中断，沿用发起时的网关路由快照，回合结束后或切模型前完成重建）。
   - 验收必须显式覆盖 4 种活跃会话场景：① 新增渠道并立即在旧会话切过去发消息；② 修改同模型 ID 的元数据（如 `baseUrl` / `compat`）；③ 删除/禁用当前选中模型；④ 流式生成进行中修改渠道配置。

### 4. 运行时平面：六大外部编码 Provider、默认种子实例与服务端安装授权门禁（闭合 Gap 3 & Gap 4）

#### 4.1 可见性与开发者开关重新划界（修正 [ADR-004](004-general-task-experience.md) 及 Q-02）

- **普通模式（开发者功能关闭）默认可见**：
  - 内置助手「小瞳」（含公司渠道与 19 类成员渠道）、**内置浏览器（PR #20 已恢复）**、**「设置 → 模型与 Agent（Providers）」**（展示「小瞳」+ 6 张推荐外部编码 Agent 卡片）、**「Coding Agent」委派设置**、普通模式可用的外部 Provider 登录终端（`ProviderAuthTerminal` / `ProviderAuthenticationSection`）、本地文件夹、改动对比/检查点、待办/插件、定时任务、技能、用量与外观。
- **开发者功能开关继续收口纯工程协作入口**：
  - Pull Requests、Issues、Source Control / 代码托管账号、Git 分支与 Worktree 管理、内嵌终端、外部 IDE 打开、克隆仓库、代码评审批注，以及其余非核心上游驱动（Cursor / Grok CLI / Fx / OpenCode / Antigravity / Kiro / Muse，开发者模式开启或经“添加自定义 Provider”可见）。

#### 4.2 干净机器随包工具链 + 四个稳定 ACP 种子实例

1. **随包验证过的 npm/npx 工具链**：扩展 `scripts/build-desktop.mjs`（目前第 55–57 行仅解出 `bin/node` 与 `LICENSE`），同时随包携带并校验匹配的 `npm`/`npx`（及其随附 JS 包与许可归属），使干净 macOS 机器在无全局 Node/npm/Homebrew 的情况下也能执行 ACP `npx` 与受管 npm 安装。
2. **服务级 `hostEnvironment` 注入**：将随包 `node/bin`（含 `node`、`npm`、`npx`）同时注入 T3 服务端的**服务级 `hostEnvironment`**（满足 `AcpRegistrySupport.ts:1653–1715` 对 `search`/`prepare` 的依赖）以及 Provider 启动环境，同时保留用户现有 `PATH` 优先级以识别用户已安装的本机 CLI。
3. **四张推荐 ACP 卡片的幂等种子迁移**：因 `ProviderInstanceRegistryHydration.ts:70` 跳过 `hasDefaultInstance === false` 的 `AcpRegistryDriver`，在 Xtwork 首次启动 / 升级迁移中为四款 ACP Agent 幂等写入稳定实例 ID（保留用户后续的修改、禁用与自定义路径，绝不覆盖）：
   - `xtworkKimiCode`：`acpRegistry` (`source: "registry"`, `agentId: "kimi-code"`)
   - `xtworkQoder`：`acpRegistry` (`source: "registry"`, `agentId: "qoder"`)
   - `xtworkCodebuddyCode`：`acpRegistry` (`source: "registry"`, `agentId: "codebuddy-code"`)
   - `xtworkDeepseekHarness`：`acpRegistry` (`source: "local"`, `commandPath: "dsh"` 或受管目录路径, `commandArgs: ["--profile", "acp"]`)
   - **关键区分**：卡片默认可见（`visible`）**绝不等同于已授权下载或自动安装**；未安装且未授权时卡片处于「未安装 · 一键安装」态，不触发任何网络下载。

#### 4.3 六大外部编码 Agent 接入与分级安装契约

明确区分**两类安装模式**，诚实声明各自的能力边界（不把任意官方 Shell 脚本包装成“可原子回滚/应用私有卸载”）：

| 类别 | 适用 Agent | 安装与运行时机制 | 能力边界（诚实契约） |
|---|---|---|---|
| **受管隔离安装（App-Managed）** | **Codex**（复用 T3 `CodexInstallation`）、**Kimi Code / Qoder / Codebuddy Code**（T3 `AcpRegistrySupport` 托管 `npx`/binary，复用随包 Node+npm）、**DeepSeek Harness**（随包 npm 安装 `@deepseek-ai/dsh` 至 `<dataDir>/tools/deepseek-harness`）、以及 **Claude Code npm 备选** | 下载/安装至应用数据目录 `<dataDir>/tools/` 或 T3 ACP 托管缓存，记录安装回执（版本、路径、来源） | 支持流式进度、取消与残留目录清理、版本核验、应用内一键卸载；不污染系统全局目录 |
| **官方脚本安装（Vendor-Managed Script）** | **Claude Code**（`curl -fsSL https://claude.ai/install.sh \| bash` / Win `irm ...`）、以及用户主动选择本机全局安装时的 **Kimi / Qoder / Codebuddy** 官方脚本 | 点击前显式展示完整命令、官方域名与写入位置；流式展示输出、支持中断进程；安装后探针核验（`--version` / ACP `initialize`）并刷新 `ProviderRegistry` | **不做虚假原子回滚或应用私有卸载承诺**：中断或卸载时明确指引官方卸载方式或清理已记录的本机路径；已有 Homebrew/全局安装时自动识别且不覆盖 |

#### 4.4 服务端统一安装授权门禁（Server-Side Install Consent Gate）

- **封堵运行时静默下载**：在 `AcpRegistrySupport.ts:1904–1921` 的 `resolve` / `prepare` 入口及自定义安装器前增设**服务端统一 Consent Gate**。
- 每次授权记录绑定五元组 `(instanceId, source, version, distribution, installDir)`：
  - 未经用户显式点击确认（含首次安装、缺包恢复、Registry 发现新版本需要升级）时，任何启动、探针或后台刷新均**不得执行下载或安装包**，仅返回结构化状态 `install_required` / `update_required` 供界面展示一键确认入口；
- **通用安装编排边界**：明确 `providerInstallation.ts:81–95` 仅支持 `codex`/`antigravity`；Xtwork 需在其之上建立统一的 **Xtwork Provider Provisioner**（或扩展 `ProviderInstallation` 注册表），将 `CodexInstallation`、受门禁保护的 `AcpRegistrySupport.prepare`、受管 npm 安装（DeepSeek Harness）与官方脚本执行器收口到统一的状态机（`idle` / `awaiting_consent` / `installing` / `verifying` / `succeeded` / `failed` / `cancelled`）。

### 5. Coding Agent 委派路由：执行、工作区、上下文与 IM 安全合同（闭合 Gap 5 & Gap 6）

#### 5.1 路由语义（明确非“尽力而为提示词”）

- 设置项保存于服务端设置：`codingAgent: { mode: "auto" } | { mode: "provider", instanceId: ProviderInstanceId, model?: string }`。
- **确定性服务端校验 + 清晰意图分工**：
  - `mode: "auto"`（默认）：由小瞳在当前对话模型上直接处理全部任务；
  - `mode: "provider"`：小瞳仍作为对话主入口处理日常问答、待办/日程/笔记插件与浏览器信息整理；**凡进入编码/改代码/调试/仓库修改类工作，必须按用户选定的目标 `instanceId` 经 T3 `delegate_task` 委派**。
  - **服务端硬守卫（拒绝静默改派）**：当小瞳调用 `delegate_task` 且用户已锁定 `codingAgent.mode === "provider"` 时，服务端校验目标 `instanceId` 状态——若目标未安装、未登录、被禁用或未授权下载，直接返回结构化阻断结果并在对话展示操作卡（`[一键安装 / 去登录]` 或 `[仅本次改用内置小瞳]`），**绝不静默切换到其他外部 Agent**。

#### 5.2 工作区与 Worktree 规则（对齐 `OrchestratorMcpService.ts:2696–2770`）

- 尊重 T3 `OrchestratorMcpService` 的真实约束：本地委派固定绑定父线程所属 `project`（提示词里写“目标目录”不会改变子进程 `cwd`）。
- **分支隔离规则**：
  - 父线程绑定到**有效 Git 仓库项目（含合法 HEAD）**时，允许按需使用 `isolation: "worktree"` 或 `"shared"`；
  - 父线程位于**非 Git 本地文件夹或免项目 `scratch/`** 时，**禁止请求 `isolation: "worktree"`**，强制使用 `"shared"` 工作区（并要求 M1c 验收覆盖免项目草稿首条消息触发委派的场景）。

#### 5.3 结构化上下文交接合同（对齐 `Orchestrator.ts:9679–9732`）

因 T3 `delegate_task` 创建子线程时仅传入显式 `task` 文本且附件列表为空（不自动移交父线程完整历史），小瞳发起委派时必须按固定结构生成交接简报：
1. **目标与验收标准**（本次编码任务要达成什么、如何自验）；
2. **约束与范围**（不得改动的边界、未提交改动的处理约定）；
3. **文件与附件引用**（用户附带的文件/路径清单，明确引用工作区相对或绝对路径）；
4. **敏感信息脱敏**（不把用户私聊中的无关个人隐私、公司密钥或待办全量数据塞进子任务）；
5. **结果回传与取消传播**：子任务完成后回传修改摘要、验证命令与遗留风险；直接复用 T3 已有的父线程停止递归取消子树能力（`ThreadManagementService.ts:1612–1670`），不重写编排取消逻辑。

#### 5.4 IM / 群聊受众红线：首版硬拒绝外部委派（对齐 [ADR-011](011-mingle-im-bridge.md) & `XtworkImMcp.ts:51–54`）

- **首版硬拒绝（Hard Deny）**：对于所有 IM 来源回合与 `replyAudience === "group"` 回合，继续保持 `XtworkImMcp.ts` 白名单**不暴露 `delegate_task`**，服务端硬拒绝将任务委派给任何外部 Coding CLI（即使桌面设置里选定了 `codingAgent.mode === "provider"`，IM/群聊回合也不触发外部 CLI 委派，直接由受 ADR-011 钩子保护的内置小瞳处理或明确提示用户在桌面发起外部编码委派）。
- **解禁前置条件**：仅当目标外部 Agent 的 T3 适配层完整具备与 ADR-011 等价的不可变 `TurnExecutionContext`、受众历史隔离、隔离工作目录路径检查以及逐工具/参数哈希绑定的 Owner 单次审批后，方可经新 ADR 评审逐步开放。单次“同意启动外部 Agent”与 `runtimeMode` 上限均**不能**替代上述边界。

## Invariants

1. **双平面解耦**：模型供应商渠道（公司渠道 + 19 类成员渠道）归属「小瞳」模型平面，外部编码 Agent 归属 T3 运行时平面；两者不混用数据结构、模型 ID 命名空间与凭据存储。
2. **统一 Proxy-Only 凭据边界**：所有公司长效 Key、成员 API Key、OAuth `access_token` 与 `refresh_token` 均仅存单一硬化 OS SecretStore 与服务端网关内存（零明文文件回退、delete 经回读验证、受登出并发栅栏保护），绝不进入 `channels.json`、`runtime/pi/models.json`、Pi 内存/磁盘、子 Coding Agent 进程、SQLite、日志或前端渲染层。
3. **团队渠道不可篡改**：`xiaotong-work-team` 的服务身份与凭据由登录态管理，未登录不暴露模型，用户仅可启停渠道和勾选模型，本地退出经密钥删除回读验证后立即停止本机暴露。
4. **服务端统一安装授权门禁**：任何第三方编码 Agent 的首次下载、缺包恢复与版本升级均须经服务端 Consent Gate 核验用户显式授权（绑定来源、版本、分发方式与安装目录），绝不静默下载，不覆盖用户既有 Homebrew/全局安装。
5. **委派单一内核与 IM 硬隔离**：Coding Agent 委派复用 T3 `delegate_task` 与父级递归取消，严格遵守父项目工作区边界、结构化交接简报与禁止静默改派规则；IM 来源及 `group` 受众回合在首版硬拒绝委派至外部 Coding CLI。

## Risk-Gated Phasing（并行推进与前置关卡）

M1b（模型平面）与 M1c（外部编码 Agent + 安装 + 委派）可并行推进，按风险关卡而非页面排期收口：

- **M1b-Gate 1（先于扩大 19 类供应商）**：
  1. 硬化共享 OS SecretStore（`missing`/`unavailable`/`denied` + 验证删除 + 并发栅栏）；
  2. 实跑验证活跃 Pi `1.5.2` 会话热刷新机制（首选扩展 `reload_models` 或受控空闲重建恢复）；
  3. 实跑验证 Proxy-Only 下的 Codex / Copilot / xAI 窄 auth/transport 适配。
- **M1b-Gate 2**：接入企业微信 OIDC 团队渠道（含 `49160` 端口冲突处理）与版本化 19 类供应商能力矩阵、稳定 `<channelId>/<modelId>` 命名、网关白名单校验与零渠道引导。
- **M1c-Gate 1（先于自动委派）**：
  1. `build-desktop.mjs` 随包验证过的 `npm`/`npx` + 服务级 `hostEnvironment` 注入；
  2. 4 个稳定 ACP 种子实例迁移 + 服务端统一 Install Consent Gate；
  3. Xtwork Provider Provisioner（受管隔离安装 vs 官方脚本安装两轨）与普通模式登录终端验收。
- **M1c-Gate 2**：接入 Coding Agent 设置与执行/工作区/上下文合同（含草稿首条消息、非 Git 工作区、父停止/子取消、审批等待、进程崩溃恢复与 IM 硬拒绝验收）。

## Consequences and Trade-offs

- **收益**：
  - 打通企业微信扫码即用与个人多供应商 + 6 大专业编码 Agent + 委派的完整闭环，同时保持双平面清晰解耦；
  - 最大化复用 T3 既有原生驱动、ACP Registry、父子编排与递归取消，避免另起炉灶；
  - 在开工前闭合活跃会话刷新、OAuth 传输适配、干净机器随包 npm、运行时静默安装、IM 安全红线与钥匙串删除验证 7 处高风险漏洞。
- **代价与仍待实跑验证项**：
  - 随包加入 `npm`/`npx` 会小幅增加安装包体积并需同步第三方许可清单；
  - 六款编码 Agent 的官方安装命令（尤其各官方 `install.sh` 的版本漂移与国内网络可用性）以及 `dsh --profile acp` 的真实 ACP 协议兼容性必须在 M1c 真机实跑验收；
  - 从 Electron 版 `xiaotong_work`（Pi `0.87.1`）迁入 Pi `1.5.2` 的供应商能力补丁需逐协议族建立自动化回归测试。

## Migration Implications

- **存量 `xtworkPi` 配置升级**：仅当 `providerInstances.xtworkPi.displayName` 为默认旧值「内置助手」时自动更名为「小瞳」；用户自定义名称保持不变。
- **开发预览单路由兼容**：在未登录公司渠道且未配置任何成员渠道时，若设置了 `XTWORK_MODEL_UPSTREAM_URL`（或本地测试模式），仍可回落到 `xtwork/standard` 预览测试线路，不破坏既有冒烟脚本与 E2E 回归。
- **Electron 版 `xiaotong_work` 关系**：遵循 [ADR-005](005-clean-v2-start.md)，v2 使用独立数据目录与独立 OS 钥匙串命名空间（`app.xtwork.model-channels`），不读写 `~/.proma/channels.json` 或 Electron `safeStorage` 密文（旧数据导入仍按 `Q-05` 单独决定）。

## Related Decisions

- [决策索引](../../DECISIONS.md)
- [ADR-004 · 默认首页面向通用任务](004-general-task-experience.md)
- [ADR-008 · 正式模型网关的部署与凭据边界](008-model-gateway.md)
- [ADR-009 · 内置 Pi 作为默认助手](009-default-pi-runtime.md)
- [ADR-011 · 基于 Mingle 渠道层与伴侣范式的内置 IM 远程连接服务](011-mingle-im-bridge.md)
- [03 内置运行时 · Pi](../plan/03-内置运行时-Pi.md) · [08 通用任务化改造](../plan/08-通用任务化改造.md) · [13 模型网关](../plan/13-模型网关.md)
