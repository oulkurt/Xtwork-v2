# 04 mygo 外壳

> 回答：外壳负责什么、不负责什么；怎样加载 T3 界面、实现桌面桥接、启动服务端。
> 【已定】外壳用 mygo，替换 Electron；保留 T3 的 React 界面和 Node 服务端。（2026-11-18）
> 相关：[01 架构](01-架构.md) · [02 上游与改造层](02-上游与改造层.md) · [09 品牌与发布](09-品牌与发布.md)

## 1. 职责边界

外壳只做三件事：
1. 窗口与系统集成：窗口、托盘、菜单、通知、文件选择、外部链接、开机自启、更新。
2. 启动并监管服务端进程。
3. 实现 T3 界面需要的桌面桥接 `window.desktopBridge`。

外壳不做：编排、持久化、插件、远程连接、模型调用。这些都在服务端一侧。

理由：服务端能脱离外壳运行（`t3` 命令行；以后也可能跑在远程机器上）。插件和远程连接跟着服务端走，外壳换掉或升级都不影响它们。

## 2. mygo 现状（2026-11-19 核实）

- 2026-11-19 查到最新稳定版为 [`v0.10.0`](https://github.com/egoist/mygo/releases/tag/v0.10.0)，发布于 2026-11-17。开工当天复查最新稳定版，锁定 tag 与提交。该版最低需要 [Go 1.27.3](https://github.com/egoist/mygo/blob/v0.10.0/go.mod#L1-L3)。使用 [mygo 文档](https://mygo.run/llms.txt) 和锁定 tag 的源码交叉核对。
- 纯 Go，无 cgo（purego）。页面跑在系统 WebView：macOS 用 WKWebView，Windows 用 WebView2，Linux 用 WebKitGTK。
- 页面与 Go 的通信：注册 Go 服务后，导出方法可以从页面调用；`mygo generate` 生成类型化的 TS 客户端；支持 channel 流和类型化事件。运行时以 `window.mygo` 注入每个页面。
- 官方插件：automation、fetch、game、glass、loading、permissionflow、render、sfsymbols、sqlite、terminal、updater、watch、websocket。
- v2 直接使用最新稳定版 API。原 `xtwork_mygo` 的壳和本地补丁可跳过。

## 3. 加载界面【建议】

**方案 A（采用）：** 服务端提供界面静态文件，窗口加载 `http://127.0.0.1:<端口>/`。

- mygo 支持：`WindowOptions.URL` 指定页面；之后可用 `win.Page().LoadURL(...)`。文档示例包含外部 HTTPS 地址和本机 HTTP 服务。
- 同源：界面与服务端 API 同源，不用改服务端的跨域白名单。服务端白名单目前只有 `t3code://app` 和 `t3code-dev://app`（`apps/server/src/httpCors.ts:13`）。
- 授权页面调用 Go：mygo 规定“不是应用自己的页面不能调用 Go 方法”，本机地址只在开发构建里自动受信。生产构建用 `PageOptions.TrustedOrigins` 加入 `http://127.0.0.1:<端口>`。端口由外壳选定，所以顺序是：选端口 → 启动服务端 → 等健康检查通过 → 建窗口。
- 按上游打包布局，把界面放进服务端的 `dist/client`。服务端从入口相邻的 `client/index.html` 自动解析静态目录。[打包脚本](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/server/scripts/cli.ts#L92-L98)

**方案 B（不采用）：** 用 `mygo.SetFrontend` 把界面打进外壳，页面源是 `mygo://localhost`（Windows 上是 `http://mygo.localhost`）。要给服务端跨域白名单打补丁，界面还要从桥接获取服务端地址。比方案 A 多一个补丁，没有收益。

**安全要求：**
- 只信任当次启动的本机页面 origin。预加载脚本在每次导航都运行，先检查 origin 再注入桥接。外部链接交给系统浏览器。
- 插件界面在沙箱 iframe 里运行，使用不透明源（sandbox 不带 `allow-same-origin`）。它拿不到 `window.mygo`，也调不到服务端 RPC，只能通过 postMessage 与宿主页面通信（见 [05](05-插件系统.md)）。
- `PageOptions.PreloadAllFrames` 保持关闭，预加载脚本不进入 iframe。
- 服务端的 MCP 端点拒绝所有带浏览器 Origin 的请求（`httpCors.ts:15` 注释：“MCP refuses every browser Origin with 403”）。插件 iframe 无法直接调用 MCP。

【待验证 M0】生产构建中加载本机地址、`TrustedOrigins` 授权、`PreloadScript` 注入三件事同时成立。

## 4. 桌面桥接【建议】

T3 界面用 `window.desktopBridge` 判断自己是否在桌面壳里：`apps/web/src/env.ts:2`，`isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined`。界面代码里有 114 处使用 `window.desktopBridge`（不含测试）。

- Electron 版：预加载脚本 `apps/desktop/src/preload.ts`（531 行）注入桥接。
- 接口：`packages/contracts/src/ipc.ts`（1,383 行）中的 `DesktopBridge`，约 90 个成员。
- mygo 对应能力：`PageOptions.PreloadScript` 在页面自己的脚本之前运行，此时 `window.mygo` 已经就绪。我们在预加载脚本里定义 `window.desktopBridge`，每个方法转成对外壳 Go 服务的调用。

分阶段实现：
- **M0 先验证浏览器模式。** 按上游本机浏览器入口走首次配对；随后用一个最小预加载脚本验证生产桥接。
- **M1：注入桥接。** 实现必需的方法，其余方法返回“不支持”的安全值。
- 桥接用 TypeScript 写，直接引用 `@t3tools/contracts` 的 `DesktopBridge` 类型。上游改了接口，编译就报错，不会静默漂移。

方法分组与 v1 处理（初稿）：

| 分组 | 成员（节选） | v1 处理 |
|---|---|---|
| 品牌与区域 | getAppBranding、getClientPlatform、getSystemLocale、getPreferredSystemLanguages | 实现 |
| 本机服务端连接 | getLocalEnvironmentBootstraps、getLocalEnvironmentBearerToken、getHostEnvironmentId、getLocalEnvironmentEnabled、setLocalEnvironmentEnabled | 实现。外壳持有启动信息，通过上游鉴权交换得到会话 Bearer，不直接把 bootstrap token 当会话令牌 |
| 客户端设置 | getClientSettings、setClientSettings、getConnectionCatalog、setConnectionCatalog | 实现。外壳负责持久化 |
| 文件与系统 | pickFolder、pickThemeFiles、pickProjectFavicon、getPathForFile、toLocalBackendPath、openExternal、openSystemSettings、readMedia、startFileDrag、showContextMenu、checkSystemPermission | 实现 |
| 窗口 | revealWindow、getWindowFullscreenState、onWindowFullscreenStateChange、getWindowZoomFactor、onMenuAction、onQuitShortcut、setTheme | 实现 |
| 通知角标 | setNotificationBadge、onNotificationBadgeClear | 映射到原生角标，平台行为见 §7 |
| 更新 | getUpdateState、setUpdateChannel、checkForUpdate、downloadUpdate、installUpdate、onUpdateState | 映射到 mygo updater |
| 遥测 | getRelayTelemetryEnabled | 固定返回 false |
| SSH、WSL、Tailscale、服务端暴露 | discoverSshHosts、ensureSshEnvironment、getWslState、setWslBackendEnabled、setTailscaleServeEnabled、setServerExposureMode、getAdvertisedEndpoints 等 | v1 不支持 |
| SnapShot、预览 | setupSnapShot 等、preview | v1 不支持。预览依赖 CDP |
| 运行时登录回调 | receiveProviderAuthCallback、cancelProviderAuthCallback | 开发者功能需要时再做 |
| 其他 | cliCommand、webLinks、appActivation、probeRemoteEditors、pasteAsText、getPrimaryPasteEnabled、restartAudioService、onTrackpadScrollBegin/End | 逐个评估 |

开工第一步：给 `DesktopBridge` 的每个成员标注“实现 / 安全默认值 / 不支持”，并检查界面在“不支持”时的降级表现。

## 5. 启动服务端【建议】

Electron 版的做法（`apps/desktop/src/backend/DesktopBackendConfiguration.ts:557-575`）：
- 可执行文件：`process.execPath`（Electron 本身），环境变量 `ELECTRON_RUN_AS_NODE=1`。
- 参数：`<backendEntryPath> --bootstrap-fd 3`，启动信息从文件描述符 3 传入。
- 其他环境变量：`T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING=1`、`T3CODE_CLI_PATH`、宿主范围变量。

mygo 外壳的做法：
- 打包一份独立的 Node。版本满足服务端 `engines`（`^22.16 || ^23.11 || >=24.10`），规划基线用上游根目录锁定的 [Node 26.13.1](https://nodejs.org/en/blog/release/v26.13.1)。
- 用 Go `os/exec` 启动 `node <server>/dist/bin.mjs --bootstrap-fd 0`。立即向 stdin 写一行 `DesktopBackendBootstrap` JSON，然后关闭输入。这个传输在上游 WSL 启动路径已有先例，计划在 macOS 和 Windows 原生打包分别验证。POSIX 可用 fd 3。Windows 的 Go `ExtraFiles` 无法传递 fd 3。[上游 stdin 参数](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/desktop/src/backend/DesktopBackendConfiguration.ts#L741-L754) · [服务端读取](https://github.com/pingdotgg/t3code/blob/3ce2145864f1e8b822cc8dff9c8cfdf39d9e450b/apps/server/src/bootstrap.ts#L74-L145)
- 环境变量：`T3CODE_TELEMETRY_ENABLED=false`；插件宿主与随包 Pi 启动器路径，以及数据目录。
- 监管：健康检查；崩溃后指数退避重启；标准输出和错误写入数据目录下的日志文件。
- 退出：在 `App.OnBeforeQuit` 里请求服务端优雅关闭（服务端负责关闭 Pi RPC 会话、模型网关和插件宿主），超时后再结束我们自己启动的进程。只结束自己记录过 PID 的进程。

为什么不用上游的单文件可执行（`build:exe`）：
- 上游说明：“The binary still resolves native packages from a node_modules tree beside it.”（`apps/server/scripts/cli.ts:184`）。单文件也省不掉 node_modules。
- T3 服务端和随包 Pi 启动器共用应用内的 Node。

服务端原生依赖（`apps/server/package.json`）：`node-pty`、`@napi-rs/keyring`、`ffi-rs`、`transcribe-cpp`、`@ff-labs/fff-node`。每个平台都要带对应的预编译文件。【待验证 M0】这些原生包在独立 Node 下全部能加载。

## 6. 窗口与后台运行

- 标题栏：`TitleBarStyle` 隐藏标题栏，`TrafficLightPosition` 调整 macOS 红绿灯位置，可选 `Vibrancy`。
- 启用后台运行时，普通关窗在 `OnClose` 里阻止关闭并隐藏窗口。显式退出时跳过隐藏逻辑，走完整的服务端和子进程清理。
- 托盘菜单：打开窗口、新对话、暂停远程连接、退出。
- 设置项「关闭窗口后在后台运行」。启用提醒或远程连接时提示开启，默认值见 Q-07。

## 7. mygo 原生能力

以下接口已在 v0.10.0 核对。跨平台实际行为按 M0/M1 的目标平台实测。

| 能力 | 对应接口 |
|---|---|
| 系统通知 | `mygo.NewNotification`、`NotificationsSupported`。macOS 用打包应用验收，Windows 和 Linux 各自检查桌面服务 |
| 单实例 | `App.RequestSingleInstanceLock`、`App.OnSecondInstance`。锁随应用 ID 或名称 |
| 开机自启 | `App.SetOpenAtLogin`、`OpenAtLogin`、`WasOpenedAtLogin` |
| 选择目录 | `mygo.Dialog.Open`、`OpenDialogOptions{Directory: true}` |
| 深链接 | 打包配置 `urlSchemes`、`App.OnOpenURL` |
| 系统凭据 | `mygo.Secrets` 支持 Set/Get/Delete。由受信 Go 代码持有，前端使用产品自己的设置接口 |
| 托盘与角标 | `mygo.MenuItem`、`App.SetBadgeCount` |

[原生能力](https://github.com/egoist/mygo/blob/v0.10.0/docs/native.md) · [应用与深链接](https://github.com/egoist/mygo/blob/v0.10.0/docs/app.md) · [应用资源布局](https://github.com/egoist/mygo/blob/v0.10.0/docs/distribution.md#platform-resources)

## 8. 体积与内存（预期）

参照：T3 Nightly（Electron）安装后占磁盘 556 MB；常驻内存合计约 900 MB：渲染进程 378、服务端 318、主进程 93、GPU 55、网络 30（单位 MB）。

换成 mygo 后：
- 省掉：Electron 主进程、GPU 进程、网络进程，以及自带的 Chromium。
- 不变：服务端约 318 MB；系统 WebView 的内容进程仍然存在。
- 新增的进程包括 Pi RPC、插件宿主和插件 worker。

预期：安装包明显变小，内存下降有限。M0 实测后再定目标值。

## 9. 打包

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS | .app + .dmg | 签名、公证、制作 dmg 都要在 macOS 机器上做 |
| Windows | exe + 安装器 | 无 cgo，可在 Linux CI 上构建；代码签名方案【待定】 |
| Linux | 可执行文件、deb、rpm、压缩包 | 首发是否包含 Linux【待定 Q-12】 |

安装包内容：外壳、Node、服务端产物与 node_modules（含平台原生包）、界面静态文件、锁定的 Pi 包和启动器、插件宿主、内置插件、全部许可文件。
