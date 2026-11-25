# 桌面预览

## 构建

首轮是 Apple Silicon macOS 13.5 或更新版本。使用 Node `26.13.1`、pnpm 和 Go `1.27.3` 或以上版本。`upstream.lock` 锁定 T3、mygo 和 Node，`runtime/pi/package-lock.json` 锁定 Pi `1.5.2` 和 npm 依赖。上游源码缓存和带 overlay 的构建副本都在 `.build/`。产品名、图标、版本和更新 URL 由 `overlay/brand/` 提供。小瞳图标沿用旧版项目的自有品牌资产。

```sh
node scripts/build-server.mjs
node scripts/build-desktop.mjs --skip-dmg
open '.build/desktop-dist/darwin-arm64/小瞳 Work v2.app'
```

省略 `--skip-dmg` 可生成 DMG。独立 Node（含随包 `npm`/`npx`）、T3 服务端及前端、Pi、moejs 插件宿主和 `im-bridge` 远程连接服务一起打包。Pi 与 `im-bridge` 通过随包 Node 运行。mygo 在本机启动服务端，用同源 WebView 加载界面。应用数据在 `~/Library/Application Support/Xtwork-v2`。用 `XTWORK_DATA_DIR` 可指定独立测试目录。

## 通用任务首页

桌面首启直接打开本机的免项目草稿。点击侧栏「新建对话」或按 `⌘N` 也会进入免项目草稿。按住 Shift 点击「新建对话」，或用草稿里的文件夹选择器，可以在现有文件夹中开始任务。已有对话仍从侧栏打开。

免项目对话共用应用数据目录下的 `scratch`。需要独立保存文件的任务可以选择不同的文件夹。测试首启时，把 `XTWORK_DATA_DIR` 指到 Git 仓库外的空目录。

桌面界面默认使用简体中文，可在「设置 → 通用 → 显示 → 语言」中切换为 English（当前仅保留简体中文与 English 两种语言）。

「设置 → 通用 → 开发者功能」默认关闭，设置由本机服务端保存。普通模式保留内置浏览器、「设置 → 模型渠道」（`/settings/channels`，[PR #28](https://github.com/oulkurt/Xtwork-v2/pull/28)）、`/settings/providers` 六大外部编码 Agent 卡片、受控一键安装与 Coding Agent 委派设置（[PR #26](https://github.com/oulkurt/Xtwork-v2/pull/26)、[PR #29](https://github.com/oulkurt/Xtwork-v2/pull/29)）、本地文件夹、改动对比和检查点、用量、待办、定时任务、技能和外观。输入框只有内置助手的标准模型可用时会收起模型选择器。普通模式新建定时任务使用所选文件夹和内置助手，编辑已有任务会保留它原来的工作区和模型。

开启后，终端、分支与工作树、编辑器、克隆和其他上游非核心外部运行时（Cursor / Grok / Fx / OpenCode / Antigravity / Kiro / Muse）恢复显示。Pull requests 和 Issues 可从「设置 → 通用 → 开发者功能」或 `⌘K` 打开。侧栏底部提供待办、设置和用量入口。内置浏览器由本机服务端浏览器提供；mygo 不提供手机配对、SSH、WSL、Tailscale、服务端暴露、CLI 安装和 SnapShot。

## 测试模型与模型平面底座

新对话默认选内置助手「**小瞳**」（实例 `xtworkPi`，[PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24) 已由旧默认名「内置助手」平滑迁为「小瞳」）。T3 通过 `provider-pi` 和 stdio RPC 启动随包 Pi `1.5.2`。

M1b（[PR #24](https://github.com/oulkurt/Xtwork-v2/pull/24)、[PR #28](https://github.com/oulkurt/Xtwork-v2/pull/28)）已在 `main` 完整落地小瞳多渠道模型平面：
- `runtime/gateway.ts` 提供保协议多协议 Proxy-Only 本机反向代理，`runtime/channelManager.ts`、`runtime/companyAuth.ts`、`runtime/providerCatalog.ts` 与 `runtime/oauthLoginFlows.ts` 接入企业微信 OIDC 团队渠道（`xiaotong-work-team`）及 19 类成员供应商（含 Codex / GitHub Copilot / xAI OAuth 订阅代理 `runtime/oauthProxy.ts`）；
- `overlay/files/apps/server/src/xtwork/modelChannelsRoutes.ts` 与 `/settings/channels`（`XtworkModelChannelsSettings.tsx`）提供渠道配置、连接测试与零渠道引导横幅（`XtworkZeroChannelBanner.tsx`）；
- `runtime/secretStore.ts` 复用 `im-bridge/src/platform/secrets.ts` 的单一硬化 OS SecretStore（`app.xtwork.model-channels` 命名空间，零明文回退、删除回读验证与并发代际栅栏）；
- `overlay/patches/042-m1b-live-refresh.patch` 为活跃 Pi `1.5.2` 会话提供模型目录热刷新；
- `overlay/files/apps/server/src/xtwork/codingAgentDelegation.ts` 与 `CodingAgentSettingsSection.tsx`（[PR #29](https://github.com/oulkurt/Xtwork-v2/pull/29)）提供确定性 Coding Agent 委派路由、阻断操作卡与 IM/群聊硬拒绝。

Pi 会话保存在 `runtime/pi/sessions`，桌面服务进程以应用数据目录内的 `workspace` 为工作目录。未配置任何渠道时，可直接在界面内打开「设置 → 模型渠道」登录企业微信或添加个人供应商；若需离线走本地 Magpie 预览兜底线路（`xtwork/standard` → 默认 `http://127.0.0.1:3425/v1` 的 `our-free-model/hy4-flash-free`），运行 `open -n --env XTWORK_DEV_FALLBACK=1 '.build/desktop-dist/darwin-arm64/小瞳 Work v2.app'`，或传 `XTWORK_MODEL_UPSTREAM_MODEL=auto/deepseek-v4.1-flash` 切到 DeepSeek 线路。`XTWORK_MODEL_UPSTREAM_URL` 可指定其它 Chat Completions 服务，`XTWORK_MODEL_UPSTREAM_KEY_FILE` 可指向只供服务端读取的密钥文件。凭据和一次性网关令牌保存在进程侧。

## 远程连接（`im-bridge`）与 Leader 控制面

PR #15–#18、[PR #21](https://github.com/oulkurt/Xtwork-v2/pull/21) 与 [PR #25](https://github.com/oulkurt/Xtwork-v2/pull/25) 已在 `main` 合入独立 Node `im-bridge` 远程连接服务（基于 `earayu/Mingle@006220e8` MIT 渠道层）、侧栏镭射卡 UI 与 [ADR-013](decisions/013-leader-supervisory-threads.md) Leader 主管 Slice 1：
- **打包与启动**：`scripts/build-desktop.mjs` 将 `im-bridge/` 打入 `.app/Contents/Resources/im-bridge/`，`shell/config.go` 向 T3 传入绝对路径 `XTWORK_IM_BRIDGE_ENTRY`、`XTWORK_IM_DATA_DIR`（`<数据目录>/im`）与 `XTWORK_COMPANION_DIR`（`<数据目录>/companion`，启动时幂等迁移至 `companion/leaders/<leaderId>/`）；未绑定任何平台时零外网长连接、零后台轮询。
- **渠道与 UI**：设置侧栏提供独立的「远程连接」入口（`/settings/remote-connections`）及飞书、个人微信（iLink）、企业微信三张 3D 镭射翻转卡片，支持扫码/凭据接入与 `pairing` 认领码流程；主侧栏普通列表上方固定渲染 Leader 主管槽位（`LeaderSidebarSlot.tsx` + `LeaderSupervisoryBar.tsx`），展示跨任务状态、Needs You 审批聚合与暂停/恢复重投控制。
- **安全边界与按 Run 策略**：`overlay/patches/034-im-bridge.patch`、`035-pi-im-security-hook.patch`、`043-leader-policy-and-sidebar.patch` 与 `overlay/files/apps/server/src/im/`（含 `XtworkLeaderStore.ts`、`XtworkLeaderAwareness.ts`）落实按 run 持久化 fail-closed 策略（`xtwork_run_policies`）、隔离任务目录、Pi 原生目录外只读/写入与 `bash` 拦截、私有/群作用域待办与记忆隔离，以及暂停期间的 `paused_pending` 积压与恢复重投。
- **待完成项**：飞书/企微/个人微信三平台真机闭环与合规边界、飞书卡片审批（Q-09）以及 Leader Stage 2/3（Q-13）仍按 [远程连接规划](plan/07-远程连接插件.md) 与 [ADR-013](decisions/013-leader-supervisory-threads.md) 验收。

离线单元与集成测试：

```sh
cd im-bridge && npm test
```

## 待办插件

工具型插件的当前范围、重试幂等规则和验证命令见 [工具型插件](plugin-tools.md)。

待办的 worker 和加载逻辑来自旧 xtwork 的 moejs 插件运行时。T3 启动独立 Go 宿主，经 JSONL 查询和调用工具。Pi 会话通过 T3 注入的 MCP 扩展发现 `todo__create`、`todo__list`、`todo__update`、`todo__complete` 和 `todo__delete`。侧栏的「待办」面板经同一宿主读取和修改待办。面板在不透明源 iframe 中运行，宿主页面转发固定的读写消息。

验证时在对话里说「记一条待办：周五前发季度报告」，对话会显示待办操作回执。通过回执打开面板或撤销，再打开「待办」查看结果，重开应用再检查一次。输入 @ 搜索待办标题，可以把待办引用到下一条消息。可通过 `XTWORK_PLUGINS_DISABLED=todo` 验证禁用状态。日程、Obsidian 和其它插件后续按工具、界面的顺序接入。

这一版支持创建、筛选、编辑、完成和删除。聊天创建的记录带对话来源。待办面板每次读取一页，可以用「加载更多」查看后续记录。提醒留待对应插件能力接入。

待办面板允许 iframe 触发表单提交事件，以支持回车新增和保存编辑。面板的 CSP 禁止原生表单提交，实际写入通过宿主页面转发。

可用 Magpie 的 DeepSeek 线路自动验收。脚本启动独立 T3 实例，由默认 Pi 创建一条待办，验证请求去重键。重启服务后在原对话里查回这条待办，并检查退出时子进程回收。

```sh
resources=".build/desktop-dist/darwin-arm64/小瞳 Work v2.app/Contents/Resources"
XTWORK_MODEL_UPSTREAM_MODEL=auto/deepseek-v4.1-flash \
  "$resources/node/bin/node" runtime/smoke-t3.mjs \
  "$resources/server/dist/bin.mjs" "$resources/runtime/pi/pi" \
  "$resources/plugin-host/xtwork-plugin-host"
```

## 更新与遥测

桌面构建使用旧 R2 域名的独立前缀 `https://xiaotongwork.skykale.cn/xtwork-v2/updates`。启用签名更新时，mygo 从 `update-darwin-arm64.json` 检查版本并校验更新包签名。开发包省略签名对时，更新在设置中显示为不可用。

发布环境提供 `XTWORK_UPDATE_PUBLIC_KEY` 和 `MYGO_UPDATER_PRIVATE_KEY`，再运行 `node scripts/build-desktop.mjs` 生成签名更新清单及归档。对外包通过 `XTWORK_MACOS_SIGN_IDENTITY` 指定 Developer ID。发布到旧 R2 的 v2 前缀依赖 AWS CLI 和 `R2_ACCOUNT_ID`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。更新 `brand.json` 版本后传 `--upload`，脚本先验证安装包，再上传版本归档，最后更新发布清单。

桌面服务端的产品分析服务使用空实现，WebView 关闭 relay 遥测。日志和本地诊断留在应用数据目录。模型请求按上面的模型配置发送。

## 验收

M1 界面回归用随包 Node、Pi 和待办宿主启动真实本机服务。Chromium 加载产包页面和 `shell/preload.js`，文件夹选择器使用临时测试文件夹，Pi 连接本地测试模型。测试覆盖首启简体中文草稿、中英双语切换与持久化、普通模式内置浏览器打开与渲染、开发者开关刷新后保持、PR 和 Issues 导航、普通模式的改动对比、定时任务表单与待办新增。运行方式如下。

```sh
node scripts/build-server.mjs
node scripts/build-desktop.mjs --skip-dmg
node scripts/test-desktop-ui.mjs
```

截图写入 `.build/desktop-ui/`。2026-11-24 验收通过 Apple Silicon 应用签名、前端类型检查、6,993 项 Web 单元与浏览器测试、Pi 设置测试及两组 Go 测试。签名发布、实际模型授权和干净机器安装按发布验收执行。

- 2026-11-20 构建并验证 Apple Silicon `.app` 签名。在 `PATH=/usr/bin:/bin` 下使用包内 Node、Pi 和 Go 宿主运行冒烟。Pi 经 Magpie 的 DeepSeek 线路调用待办工具，重启后在同一对话读回，去重键有效。
- 使用旧 Dim Alpha 冒烟数据副本升级。旧对话保持 Dim 归属，待办和自选模型仍可用，新对话使用 Pi。连续重启两次，迁移后的设置保持一致。
- Pi RPC 实测流式文本增量、取消后上游断开、默认模型发现和 Bash 令牌过滤。锁定 T3 的 `provider-pi` 测试通过 244 项。待办面板的标题栏避开桌面右上角控制区，@ 待办引用会保存 todo-item 记录。桌面取消按钮、交互审批和正式发布仍按 [里程碑](plan/10-里程碑与验收.md) 验收。

### Dim Alpha 历史验收

- 在打包应用中打开待办面板并创建记录，退出重开后记录仍可查看。退出后本机 Node 服务停止。
- Magpie 的 Hy 4 Flash Free 返回免费额度上限。通过 `auto/deepseek-v4.1-flash` 验证了真实 Dim 流式回复，以及经 T3 MCP 创建、重启并查询待办。
- 用本地签名更新源验证下载、安装、重启和拒绝被篡改的归档。R2 的 v2 前缀当前还没有发布清单。
