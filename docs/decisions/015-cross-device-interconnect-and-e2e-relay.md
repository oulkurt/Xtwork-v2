# ADR-015 · 跨设备互联、渐进式零账号盲转 E2E 中继与可插拔身份控制面

- **Date** 2026-11-26（2026-11-27 对账至 `main@4b6933f` 顺延定号 `ADR-015`，补充首期渐进式 E2EE 口径）
- **Status** Accepted（方向与分阶段推进路线已定，作为独立演进线 M6 推进，暂不排期开工，不阻塞 M1–M5 桌面与 IM 首发验收；局部细化 [ADR-001](001-desktop-architecture.md)、[ADR-012](012-xiaotong-model-channels-and-coding-agents.md) 与 [ADR-013](013-leader-supervisory-threads.md) Stage 3 的多机边界）
- **Evidence** Confirmed · 2026-11-26 项目负责人确认采用「T3 权威环境 + 直连优先/盲转 E2E 中继兜底 + 零账号默认/可插拔身份层」路线；2026-11-27 进一步确认「E2EE 作为中继目标方向欧克，但一开始做不到也没关系」，允许先以直连（LAN/Tailscale/SSH）闭环、公网中继按需分步由传输层 TLS 最小中继渐进升级至完整盲转 E2EE；方案经 Gemini 4 Neon 与 GPT-6.2 Astra 对锁定上游 `t3code@3ce21458`（`remote.md`、`connection-runtime.md`、`devices.md`、`t3-connect.md`、`PeerLinks.ts`、`DeviceHubProxy.ts`、`DesktopAppUpdate.ts`、`DesktopTelemetryReceiver.ts`）、[`nanami-0713/relay-kit`](https://github.com/nanami-0713/relay-kit)（MIT）及 [`LodyAI/Lody`](https://github.com/LodyAI/Lody)（Apache-2.0）独立源码核对后定稿。

> **证据分层约定**：锁定上游 T3 Code 的多环境路由、`PeerLinks`、`DeviceHubProxy` 与 `DesktopAppUpdate` 机制均经 `t3code@3ce21458` 源码静态核实；`relay-kit` 的盲转帧格式与 `Lody` 的 E2EE/设备信任规格均经公开仓库源码核实（注：Lody 白皮书明确声明其生产 E2EE 入口尚未开放且未经第三方密码学审计，Recovery Vault 不在 MVP，iroh 打洞与安装加载仍待实测）；本 ADR 定义的 `xtwork-relay/v1`、mygo 壳扩展与 M6 分阶段验收均属**已批准规划（As-Designed）**，代码合入并实机验证前不计入 As-Built 能力。

## Context

小瞳 Work v2 在 M1 阶段按 [ADR-004](004-general-task-experience.md) 与 [09 品牌与发布](../plan/09-品牌与发布.md) 关闭了 T3 Connect（Clerk 账号 + pingdotgg 托管中继），并在 `desktopFeatureVisibility.ts`、`037-developer-features.patch`、`shell/backend.go` 与 `shell/preload.js` 中一并屏蔽了上游的 `/settings/connections`、`/settings/access`、`/settings/devices`、`LinkedEnvironments`、右侧 `DevicePanel`、SSH/局域网暴露桥接与远程桌面更新管道。同时，手机端远程派活已由 [ADR-011](011-mingle-im-bridge.md) 的内置 `im-bridge`（飞书 / 企微 / 个人微信）与 [ADR-013](013-leader-supervisory-threads.md) 的领航员（Navigator）承接。

然而，用户在多台电脑之间协同（例如从个人电脑或 Linux 工作站控制公司 Mac 上的对话、实时查看并操作远端 Mac 上运行的 iOS 模拟器、跨机委派不同智能体协作、以及从一台电脑远程触发另一台电脑更新桌面版）仍是极具价值的高阶场景。源码核查表明：

1. **去掉 T3 Connect ≠ 失去跨设备能力**：上游 T3 Connect 仅是“账号发现 + 自动 Cloudflare Tunnel 穿网 + 短期 DPoP 凭据签发”控制面，正常会话流量、`/api/device-hub` 模拟器画面流、`PeerLinks` 跨机 `/mcp` 转发以及 `ServerSelfUpdate` / `DesktopAppUpdate` 均运行在标准 HTTP/WS/MCP 之上，底层不强依赖 T3 Connect 或 Clerk。
2. **产品面向外部用户交付，绝不能绑定自有企业微信**：虽然 [ADR-012](012-xiaotong-model-channels-and-coding-agents.md) 在模型平面接入了公司企业微信 OIDC 渠道，但跨设备互联必须支持**零账号开箱即用**与**用户自托管中继**，企业微信只可作为未来企业版可选的目录/身份 Adapter，不得写死进跨设备协议。
3. **两类外部开源参考各有所长与边界**：
   - [`nanami-0713/relay-kit`](https://github.com/nanami-0713/relay-kit)（MIT）证明了“零账号、盲转字节中继、CF Workers DO Hibernation 空闲低成本、可自托管”的传输形态可行，但直接套入 T3 存在 5 处硬伤：E2E 模式缺少发送背压且响应体经历双重 Base64 膨胀（约 +78%）、`TunnelResponse` 全量缓存响应体无法承载无限 AVCC/MJPEG 视频流、请求体单帧不分块撞上 T3 50 MiB 文件上传上限、单 256-bit `code` 承担全部权限且任何知晓 `routingToken` 者均可触发 `4000` 抢占 DoS、自制 PAKE 未经形式化验证与审计，以及 `*.workers.dev` 在中国大陆直连不可达。
   - [`LodyAI/Lody`](https://github.com/LodyAI/Lody)（Apache-2.0）在设备独立 Ed25519 密钥、防中继替换的带外配对秘密、机器共享策略与 `generation` 隔离、签名执行意图（Signed Execution Intent）与统一幂等 claim 上极具参考价值；但其产品仍依赖云账号 + Convex + Loro Streams 后端，且以 CRDT 为核心状态机、引入 Rust `iroh-native`（NAPI/UniFFI）原生扩展，与 T3 的 Server-Authoritative 架构及 [ADR-006](006-upstream-update-policy.md) 薄改原则冲突。

## Problem

在不破坏 [ADR-001](001-desktop-architecture.md)（mygo 壳职责边界）、[ADR-006](006-upstream-update-policy.md)（薄改上游）、[ADR-011](011-mingle-im-bridge.md)/[ADR-012](012-xiaotong-model-channels-and-coding-agents.md)/[ADR-013](013-leader-supervisory-threads.md)（IM/群聊安全红线与本地 Coding Agent 确定性路由）的前提下，如何为**可交付给任意外部用户**的小瞳 Work 补齐跨设备互联与多机流转能力，同时一次闭合以下七处关键工程与安全缝隙：

1. **三层解耦与渐进落地**：避免把“穿网传输”“T3 权威数据面”与“账号身份发现”揉成强绑定体系，确保无账号个人用户、自托管极客与企业客户都能使用同一套核心协议，同时让首期落地不被自研密码学 E2EE 握手卡住交付节奏。
2. **`PeerLinks` 拒绝 Loopback 的双接入缝问题**：T3 上游 `apps/server/src/peer/PeerLinks.ts` 明确拒绝把 `isOwnLoopback` 地址存为远端机器地址（防本机伪造与端口漂移），因此控制端前端 UI 经 `127.0.0.1` loopback proxy 访问远端与服务端间 `PeerLinks` 调远端 `/mcp` 不能混用同一条未认证 loopback TCP 地址。
3. **大文件与模拟器长流承载**：中继协议必须支持 50 MiB 请求体流式分块、无双重 Base64 的二进制帧、端到端背压以及实时流式响应，且明确区分直连 WebRTC 与中继 AVCC/MJPEG 媒体降级策略。
4. **零账号下的防抢占、防中间人与单设备吊销**：不能复用 `relay-kit` 的单 `code` 全权限模型与可被抢占的房间注册机制，必须让配对码仅作一次性 bootstrap 凭证，单台控制设备可独立撤销。
5. **与现有 Coding Agent 锁定及 IM 红线的协调**：遵守 `codingAgentDelegation.ts` 在锁定本地 Coding Agent 时对远端 `target.environmentId` 的保护，并严格保持 IM/群聊及受保护祖先链的外部委派与跨机转发 fail-closed 硬拒绝。
6. **mygo 外壳的跨平台远程更新通道**：T3 上游 `DesktopAppUpdate` 依赖 `desktopTelemetryFd` / `desktopTelemetryControlFd` 双管道执行两阶段更新 handoff（prepare → confirm → commit），但 Go `os/exec.Cmd.ExtraFiles` 仅适用于 POSIX（macOS/Linux），Windows 需独立 IPC 适配方案。
7. **中国大陆网络可达性与可控运维成本**：不将 `*.workers.dev` 作为默认交付地址，避免持续视频流击穿 CF Workers DO 请求与带宽预算。

## Considered Alternatives

| 方案 | 概要 | 结论 |
|---|---|---|
| **方案 A：恢复上游 T3 Connect + Clerk** | 直接放开上游 `infra/relay` 客户端接入与 Clerk 登录 | **拒绝。** 强依赖第三方 Clerk 与 pingdotgg 生态，无法独立品牌交付，且大陆可达性与私有化不可控。 |
| **方案 B：照搬 Lody 架构（Loro CRDT + Convex + `iroh-native`）** | 引入 CRDT 云流同步、签名权限账本与 Rust NAPI `iroh` P2P | **拒绝。** 与 T3 Server-Authoritative 线程/文件/执行状态机根本冲突，破坏 [ADR-006](006-upstream-update-policy.md) 薄改原则；无法原生表达 `DeviceHubProxy` 视频流与两阶段桌面更新，且首期引入 Rust NAPI 大幅推高全平台打包与签名成本。 |
| **方案 C：绑定自有企业微信 OIDC 的私有控制面** | 用公司 Keycloak/企微 OIDC 替换 Clerk 构建中心化中继 | **拒绝作为默认方案。** 无法交付给没有企业微信的外部个人或第三方团队用户，把产品基础能力锁死在单一公司身份源上。 |
| **方案 D（采用）：T3 权威数据面 + 直连优先 / 渐进式零账号盲转 E2E 中继 + 可插拔身份控制面** | 保持 T3 服务端为唯一数据与执行权威；传输层按 `Direct/LAN → Tailscale/SSH → 中继 (xtwork-relay/v1，目标盲转 E2EE，允许首期先走直连或传输层 TLS 最小中继平滑过渡)` 优先路由；默认零账号二维码/Pairing URI 配对（借鉴 Lody 防篡改秘密与每设备独立身份，降级配对码为一次性 bootstrap），企业 OIDC/企微仅作为后期可选 Identity Adapter | **采用。** 既满足外部用户零门槛开箱与自托管需求，又以最小补丁量完整复用 T3 原生线程、`DeviceHubProxy`、`PeerLinks` 与 `DesktopAppUpdate`，同时允许首期先通闭环再平滑补齐盲转 E2EE，避免被密码学工程阻塞首版节奏。 |

## Decision

### 1. 总体三层解耦架构

```text
┌──────────────────────────────────────────────────────────────────────┐
│  L3 · 可选身份与发现控制面（Identity Adapter — 默认关闭，零账号可用）  │
│  ├─ Mode 0（默认 · 全部外部用户）：零账号，二维码 / Pairing URI 配对   │
│  ├─ Mode 1（通用云 / 自建团队）：Passkey / 邮箱 / 通用 OIDC            │
│  └─ Mode 2（企业交付插件）：企业微信 OIDC / 飞书 / Azure AD（可选）     │
├──────────────────────────────────────────────────────────────────────┤
│  L2 · 多路传输路由层（Route Layer — 挂接在 T3 connection runtime 之下）│
│  1. Direct / LAN（局域网直连：最低延迟、支持 WebRTC / AVCC / 50MB 上传）│
│  2. Tailscale / SSH（已有组网或 SSH 隧道直接复用，自带 WireGuard/SSH 加密）│
│  3. 中继路径（xtwork-relay/v1：二进制帧 + 请求分块 + 背压）            │
│     · M6.2a 可选过渡：传输层 TLS + Host 质询 + T3 原生鉴权（界面明示） │
│     · M6.2b 目标终态：零账号盲转 E2EE（X25519 + Ed25519 + AEAD）       │
│     · 客户端 UI：mygo/本机 127.0.0.1 Loopback Gateway（Secure Context）│
│     · 服务端 PeerLinks：进程内 Relay Transport（逻辑地址，不走 Loopback）│
│     · 同时提供单二进制 Go 中继（大陆 VPS/内网自托管）与 CF Worker DO    │
│  4. [远期可选] iroh / QUIC P2P 打洞（经实测与打包成本评估后再决定）     │
├──────────────────────────────────────────────────────────────────────┤
│  L1 · T3 权威环境层（100% 复用上游数据面，严守 ADR-006 薄改边界）       │
│  ├─ 会话与权限：标准 EnvironmentAuth（每控制端独立 Session + Scope 吊销）│
│  ├─ 跨机智能体：标准 /mcp + PeerLinks / PeerForwarding + 签名意图信封  │
│  ├─ 模拟器串流：标准 /api/device-hub（直连 WebRTC，中继 AVCC/MJPEG+WS）│
│  └─ 远程更新：标准 ServerSelfUpdate / DesktopAppUpdate 两阶段 handoff  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2. 对 `relay-kit` 的四项必改升级与渐进 E2EE 路径（`xtwork-relay/v1` 协议契约）

采用 `relay-kit` 的“出站 WS 中继 + 可自托管 + Hibernation 思想”，但**不原样引入其 v1 协议与客户端**，在 `xtwork-relay/v1` 中必须完成以下升级；同时按 2026-11-27 确认口径，允许中继在工程上分为 **M6.2a（传输层 TLS 最小中继，可选过渡）→ M6.2b（完整盲转 E2EE 目标态）** 两步平滑演进，二者复用同一套二进制帧、Host 质询注册、Loopback Gateway 与 `PeerLinks` 逻辑地址抽象：

1. **宿主身份质询注册（封堵 `4000` 抢占 DoS，M6.2a/M6.2b 均必选）**：被控端生成持久化 **Host Ed25519 密钥对**（存入既有硬化 OS SecretStore 独立命名空间 `app.xtwork.cross-device`，零明文回退），房间 ID 由 `hostPubKey` 派生；被控端向中继注册 `/agent` 时须对中继下发的随机 nonce 做 Ed25519 签名验证，知晓 `routingToken` 或客户端 URL 的第三方无法抢占或踢掉合法宿主。
2. **标准双向认证与一次性配对（目标态 M6.2b 盲转 E2EE；允许 M6.2a 先以 TLS + T3 原生鉴权过渡）**：
   - 配对二维码 / URI 携带 `{ relayUrl, roomId, hostPubKey, pairingSecret(128-bit), t3PairingCode, expiresAt }`，仅作**一次性短期 bootstrap**（10 分钟有效、使用即作废）。
   - **M6.2b（目标终态 · 盲转 E2EE）**：E2E 隧道握手采用标准 **X25519 临时 ECDH + Ed25519 双向签名认证（绑定完整 transcript 与 `pairingSecret`）+ AEAD（AES-256-GCM 或 XChaCha20-Poly1305）+ 每方向严格递增 uint64 counter 防重放**，中继全程不可解密也无法替换公钥。
   - **M6.2a（允许的首期过渡形态）**：若首期暂不落地应用层 E2EE，中继链路必须强制 `wss://`（TLS）+ Host Ed25519 质询 + T3 原生 `/oauth/token` 每设备独立 Session，并在 UI 与文档中**明确标注「传输层加密中继（非盲转 E2EE），建议优先使用直连/Tailscale/SSH 或自托管节点」**，同时在协议帧头预留 `encryptionMode` 能力协商位以便无痛升级到 M6.2b。
   - 无论 M6.2a 还是 M6.2b，控制端均换取**本机专属 `clientPubKey` 绑定的 T3 Environment Session**；在被控端撤销任一控制设备时**同时断开该设备的中继隧道并吊销其 T3 Session**，不影响其他设备。
3. **二进制分块与流式背压（支撑 50 MiB 上传与 iOS 模拟器长流）**：
   - 取消 JSON+双重 Base64 包装，外层与内层统一采用**二进制长度前缀帧**；
   - 请求方向补齐流式分块（`hbegin` / `hchunk` / `hend` / `hcancel`，含总长、校验与取消语义），完整承载 T3 50 MiB 文件与 10 MiB 图片上传；
   - 响应方向接入双向背压，控制端本机 Loopback Gateway 边收边写入 HTTP 流，严禁全量缓冲后返回；明确媒体降级策略：**直连/Tailscale 优先 WebRTC，中继路径走 AVCC（依赖本机 `127.0.0.1` Secure Context 解码 WebCodecs）或 MJPEG + 输入 WS，不承诺经盲转 WS 中继跑 WebRTC 媒体**。
4. **双实现中继服务端（解决中国大陆可达性与自托管）**：
   - 维护协议完全一致的**单二进制 Go 中继服务**（复用项目现有 Go 工具链，可一键部署在任意大陆可达 VPS 或企业内网，作为官方默认节点与私有部署首选）与 **Cloudflare Workers Durable Objects（WebSocket Hibernation，要求绑定自定义域名，禁止把 `*.workers.dev` 设为默认交付地址）**。

### 3. 双接入缝与薄改边界（闭合 `PeerLinks.ts` Loopback 限制）

- **前端 UI 接入缝**：mygo 壳（或受监管本机代理模块）为每个经中继连接的远端环境暴露按次认证的 `127.0.0.1:<port>` Loopback Gateway，作为 `ConnectionResolver` 的新 route target 接入上游 `ConnectionDriver.connectOverRoutes`（天然复用上游 500ms 直连竞速、断线退避与回退机制，且 `127.0.0.1` 自动满足浏览器 WebCodecs 的 Secure Context 要求，`apps/web` 与 `DevicePanel` 零协议改写）。
- **服务端 `PeerLinks` 接入缝**：保留 `apps/server/src/peer/PeerLinks.ts` 对 `isOwnLoopback` 的拒绝保护，严禁把临时 loopback 地址持久化为 Peer URL；`PeerLinks` 持久化逻辑路由（如 `xtwork-relay://<relayHost>/<roomId>` + 已钉选的 `hostPubKey` 与 `expectedEnvironmentId`），通过服务端进程内 Relay Transport 发起 `/mcp` 调用，完整继承 `T3-Mode-Limit`、`linkOrigin` 围栏与接收端原生权限检查。
- **前端入口策略**：不整体恢复带有 Clerk / T3 Connect / Electron 假设的上游连接设置页；在 Xtwork 自有设置中提供独立的「跨设备互联」卡片（复用 `connection-catalog` 存储），并在启用跨设备互联或开发者功能时按需放开 `DevicePanel` 与受控的跨机委派入口。

### 4. 与现有安全红线的协调（ADR-011 / ADR-012 / ADR-013 / ADR-014）

1. **IM / 群聊与受保护线程硬拒绝不变**：无论本机是否开启跨设备互联或配置中继，所有 IM 来源回合、`group` 受众回合及其派生子线程祖先链在首版继续由 `codingAgentDelegation.ts` 与 `XtworkImMcp.ts` **fail-closed 硬拒绝**外部 Coding Agent 委派与跨机转发；未来开放多机器受保护任务转发时必须满足 [ADR-013 §6](013-leader-supervisory-threads.md#6-明确排期延后的能力受上述已定安全契约约束) 不变量（目标主机无法校验执行策略时一律拒绝）。
2. **本地 Coding Agent 锁定规则保持一致**：当桌面端将 `codingAgent.mode` 锁定为本地外部 Provider 时，继续按 `codingAgentDelegation.ts` 拒绝隐式跨机绕过；仅在 `codingAgent.mode === "auto"` 或显式桌面跨机委派场景下，放行桌面 `local_only` 线程通过 `PeerLinks` 向远端发起任务。
3. **跨机委派增量审计信封（借鉴 Lody）**：在保留 T3 接收端权威鉴权的前提下，为跨机 `PeerForwarding` 附加轻量的签名执行信封（绑定 `issuerDevicePubKey`、`sourceEnvironmentId`、`targetEnvironmentId`、`sourceThreadId`、`operation`、`modeLimit`、`requestId`、`expiresAt`），并在接收端与统一幂等 claim 联动，用于来源不可抵赖、防重放与审计，不替代接收端既有授权检查。

### 5. 风险门禁驱动的五阶段推进顺序（M6.0 → M6.4）

详细入口条件、代码边界、退出门禁与验收矩阵见 [14 跨设备互联与多机流转](../plan/14-跨设备互联与多机流转.md)，总推进顺序定案如下：

- **M6.0 · Gate 0：传输能力矩阵与协议冻结**（只落契约与测试夹具，不改产品代码）：冻结 `xtwork-relay/v1` 二进制帧/分块/质询注册规范（含 `encryptionMode` 升级位与 E2EE 握手测试向量）、双接入缝接口、mygo 更新管道跨平台契约与 10 项必测传输能力矩阵。
- **M6.1 · 直连 / Tailscale / SSH 闭环 + 远端模拟器 + 桌面跨机委派**（零云端运维、无需自研 E2EE，先跑通全部 T3 能力）：在 mygo 壳补齐 LAN 绑定、Tailscale Serve 与 SSH 隧道桥接；上线 Xtwork 精简「跨设备互联」卡片并放开 `DevicePanel`；验证桌面 `local_only` 跨机控制线程、看并操作远端 Mac iOS 模拟器、跨机 `PeerLinks` 委派与取消恢复（IM/群聊保持硬禁）。
- **M6.2 · 零账号公网中继（`xtwork-relay/v1`）+ 本机 Loopback Gateway + 自托管（渐进 E2EE）**：交付单二进制 Go 中继服务 + CF Workers DO（自定义域名）双服务端实现、一次性二维码/URI 配对、Host 质询注册、每设备独立撤销、50 MiB 分块上传与 AVCC/MJPEG 流式背压验收；直连与中继在 `ConnectionDriver` 中自动竞速回退。允许先以 **M6.2a（TLS + Host 质询 + T3 鉴权，UI 显式提示非盲转 E2EE）** 打通跨公网可用，再升级至 **M6.2b（完整 X25519+Ed25519+AEAD 盲转 E2EE）** 达成终态。
- **M6.3 · mygo 壳远程两阶段桌面更新 + 跨平台补齐**：在 `shell/backend.go` 与 `shell/updates.go` 补齐 `desktopTelemetryFd` / `desktopTelemetryControlFd`（POSIX 走 `ExtraFiles` fd 4/5 对齐上游零服务端补丁，Windows 评估并落地等价本地 IPC 通道），打通受 `environment:maintain` 权限约束的 prepare → confirm → commit 远程更新闭环；结合 `Q-12` 与 `Q-15` 评估 Linux（含 Omarchy）桌面端或无头服务端形态。
- **M6.4 · 可插拔身份控制面 + 机器共享与远期 P2P 加速**：抽象 `IdentityAdapter`（支持 Passkey / 通用 OIDC / 企业微信 OIDC 平级可插拔，提供账号下多设备自动发现，零账号模式始终可用）；借鉴 Lody 落地按项目机器共享策略与 `generation` 隔离；仅在实测延迟与打包成本通过门禁后评估引入 `iroh` / QUIC 打洞作为可选加速路由。

## Invariants

1. **三层解耦与零身份绑定**：跨设备核心协议严禁硬编码企业微信、Clerk 或任一单一云厂商身份；零账号配对模式与自定义自托管中继 URL 为永久一等能力。
2. **T3 权威数据面唯一性**：线程、文件、设备代理、跨机委派与桌面更新均保留 T3 上游 Server-Authoritative 状态机，严禁引入平行 CRDT 状态机或第二套权限判定源。
3. **宿主防抢占与加密边界诚实可见**：房间注册必须通过 Host Ed25519 质询签名，知晓路由信息不得抢占宿主槽位；进入 M6.2b 盲转 E2EE 终态后中继永远不持有解密密钥；若短期启用 M6.2a 传输层 TLS 过渡中继，UI 必须诚实明示「非盲转 E2EE」且不静默默认接入不可信公网节点。
4. **配对码一次性与单设备可独立撤销**：配对码仅作一次性 bootstrap 凭证；每个控制端持有独立设备密钥与 T3 Session，撤销单台控制端立即断流并吊销授权，不连带其他设备。
5. **Loopback 隔离边界**：`PeerLinks` 严禁将临时 `127.0.0.1` loopback 地址保存为远端环境 URL，跨机 `/mcp` 必须经服务端受控通道并严格保留 `T3-Mode-Limit` 与 `linkOrigin` 围栏。
6. **IM 与受保护任务红线不可绕过**：新增直连或中继路由均不得绕过 [ADR-011](011-mingle-im-bridge.md)、[ADR-012](012-xiaotong-model-channels-and-coding-agents.md) 与 [ADR-013](013-leader-supervisory-threads.md) 的受众隔离、目录闸门与 IM 外部委派硬拒绝。

## Consequences and Trade-offs

- **收益**：
  - 彻底打破“去掉 T3 Connect 就无法跨设备/看模拟器/跨机委派/远程更新”的耦合假设，以最小补丁量拿回 T3 Code 全套高阶跨设备体验；
  - 面向外部用户可做到零账号开箱即用 + 一键自托管中继，面向企业交付又可平滑挂载通用 OIDC 或企业微信目录，兼顾个人与团队场景；
  - 通过 M6.1 先跑通直连闭环、M6.2 再接中继（且允许 M6.2a TLS 过渡 → M6.2b 盲转 E2EE 渐进升级）、M6.3 再补远程更新的分阶段顺序，避免在未验证底层连接模型前提前背上中继、密码学握手与多端更新运维包袱。
- **代价与待验证项**：
  - 需自研并维护轻量的 `xtwork-relay/v1` 协议、单二进制 Go 中继服务与控制端 Loopback Gateway，且须在 M6.2b 对外宣称盲转 E2EE 前对握手与帧协议做独立安全复核；
  - 若首期启用 M6.2a 传输层 TLS 过渡中继，须接受中继运维方在逻辑上可见 TLS 终结后的明文流量，因此默认仅面向自托管/受控中继并清晰提示安全级别；
  - 中继路径不支持 WebRTC 媒体，远端模拟器在中继下依赖 AVCC/MJPEG 流式带宽与背压调优，官方托管节点的视频流带宽成本需在 M6.2 压测并定配额策略；
  - M6.3 的 Windows 远程桌面更新通道无法直接复用 POSIX fd 4/5，需要跨平台 IPC 适配与真机验收；Linux 端（如 Omarchy）若纳入交付范围需独立验收 mygo WebKitGTK 打包。

## Migration Implications

- **不破坏存量单机与 IM 数据**：M6 全部能力默认关闭（未主动开启跨设备暴露或添加远端设备时，本机服务端继续仅监听 `127.0.0.1`，零新增外网连接），不影响现有 `userdata/statev2.sqlite`、`im.db`、`channels.json` 与 `companion/leaders/`。
- **凭据命名空间隔离**：跨设备 Host Ed25519 私钥与控制端设备密钥使用硬化共享 OS SecretStore 的独立命名空间 `app.xtwork.cross-device`（与 `app.xtwork.im-bridge`、`app.xtwork.model-channels` 严格隔离，零明文回退）。
- **上游同步兼容**：客户端沿用 `ConnectionResolver` / `connection-catalog`，服务端保留 `PeerLinks`、`DeviceHubProxy` 与 `DesktopAppUpdate` 上游主逻辑，后续按 [ADR-006](006-upstream-update-policy.md) 升级 T3 稳定版时补丁维护面可控。

## Related Decisions

- [决策索引](../../DECISIONS.md)
- [14 跨设备互联与多机流转](../plan/14-跨设备互联与多机流转.md)
- [ADR-001 · 桌面与服务端边界](001-desktop-architecture.md)
- [ADR-004 · 默认首页面向通用任务](004-general-task-experience.md)
- [ADR-006 · 上游升级节奏](006-upstream-update-policy.md)
- [ADR-011 · 基于 Mingle 渠道层与伴侣范式的内置 IM 远程连接服务](011-mingle-im-bridge.md)
- [ADR-012 · 小瞳模型渠道与编码 Agent 委派](012-xiaotong-model-channels-and-coding-agents.md)
- [ADR-013 · Leader 主管实体与多机安全契约](013-leader-supervisory-threads.md)
- [ADR-014 · 领航员控制面 v2（后续规划待办）](014-navigator-control-plane-v2.md)
- [04 mygo 外壳](../plan/04-mygo外壳.md) · [07 远程连接插件](../plan/07-远程连接插件.md) · [09 品牌与发布](../plan/09-品牌与发布.md) · [10 里程碑与验收](../plan/10-里程碑与验收.md) · [11 风险与待定](../plan/11-风险与待定.md)
