# 小瞳 Work v2

小瞳 Work 的下一版，面向日常任务。当前处于 Apple Silicon Mac 的 Alpha 预览（基线 `main@9d792e7`），已落地默认简体中文界面、普通模式内置浏览器、内置助手「小瞳」（随包 Pi `1.5.2` + 企业微信公司渠道 + 19 类供应商模型平面与硬化 OS 钥匙串）、6 大外部编码 Agent 普通模式一键安装与确定性 Coding Agent 委派路由、插件 v2 双轨与待办对话通路、独立 Node `im-bridge` 远程 IM 连接服务，以及领航员（Leader）控制面 Slice 1/2 与动态 Bot 头像。[查看当前进度](docs/README.md#当前进度)

## 已确认的方向

- v2 取代 xtwork。保留 T3 Code 的 React 界面、Node 服务端和任务编排，桌面壳使用 mygo。预览锁定 `v0.10.0`。[构建版本锁](upstream.lock)
- 随应用内置 Pi 作为默认助手并定名为「小瞳」，通过 T3 原生 Pi 适配层与 Proxy-Only 多协议模型网关接入企业微信公司渠道及 19 类成员模型供应商。日常界面使用自有品牌，第三方许可随安装包发布。[运行时设计](docs/plan/03-内置运行时-Pi.md) · [模型与外部 Agent 决策](docs/decisions/012-xiaotong-model-channels-and-coding-agents.md)
- 默认首页以通用任务为主，默认简体中文（`zh`/`en` 双语）。普通模式保留内置浏览器、6 大外部编码 Agent（Claude Code / Codex / Kimi Code / Qoder / Codebuddy Code / DeepSeek Harness）一键安装与 Coding Agent 委派；Pull requests、Issues、Git/Worktree、终端等纯工程入口放到设置内的开发者功能区。[通用任务规划](docs/plan/08-通用任务化改造.md)
- 用 moejs 做功能插件（插件 v2 功能/外观双轨），待办、日程和 Obsidian 进入首发验收。IM 远程连接复用 Mingle（MIT）渠道层与伴侣范式，以 T3 侧独立 Node 服务 `im-bridge` 提供，首发飞书、微信（iLink）和企业微信，并由一等 `Leader` 主管统一承接远程绑定与跨任务感知。[远程连接决策](docs/decisions/011-mingle-im-bridge.md) · [Leader 决策](docs/decisions/013-leader-supervisory-threads.md)
- v2 独立搭建。历史 `xtwork_mygo` 只提供可选参考，旧外壳、本地补丁和数据迁移都不构成开工依赖。

## 运行桌面预览

在 macOS 13.5 或更新版本的 Apple Silicon Mac 上安装 Node `26.13.1`、pnpm 和 Go `1.27.3` 或以上版本，再运行：

```sh
node scripts/build-server.mjs
node scripts/build-desktop.mjs --skip-dmg
open '.build/desktop-dist/darwin-arm64/小瞳 Work v2.app'
```

首次打开可通过「设置 → 模型渠道」（`/settings/channels`）扫码登录企业微信公司渠道或添加 19 类成员供应商。若需离线连接本机 Magpie 开发测试线路，可通过 `open -n --env XTWORK_DEV_FALLBACK=1 '.build/desktop-dist/darwin-arm64/小瞳 Work v2.app'` 启动，或传 `XTWORK_MODEL_UPSTREAM_MODEL=auto/deepseek-v4.1-flash` 切到 DeepSeek 线路。构建、模型参数和 R2 更新见 [桌面开发说明](docs/desktop-foundation.md)。

## 数据与隐私

应用关闭使用量遥测和远程诊断导出。待办和对话记录保存在本机。发送消息后，助手会把处理请求所需的对话和工具结果交给已配置的模型服务。更新检查访问小瞳的 R2 发布源。

## 预览交互（历史原型）

[打开交互原型](.smyw/20261119-xtwork-v2/preview.html)（2026-11-19 规划期静态原型，使用示例数据，非现行 UI 规范）。点「演示」可回顾早期对聊天记待办、加日程、引用笔记与设置的设想；现行界面与架构以 `docs/` 实现说明及 `DECISIONS.md` 为准。

## 文档地图

- [项目进度、权威层级与文档目录](docs/README.md)
- [已确认的决策与待定事项](DECISIONS.md)
- 文档一致性检查：`node scripts/check-docs.mjs`
