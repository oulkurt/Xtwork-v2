# 小瞳 Work v2

小瞳 Work 的下一版，面向日常任务。当前处于 Apple Silicon Mac 的 Alpha 预览，已接通内置助手和待办管理。[查看当前进度](doc/README.md#当前进度)

## 已确认的方向

- v2 取代 xtwork。保留 T3 Code 的 React 界面、Node 服务端和任务编排，桌面壳使用 mygo。预览锁定 `v0.10.0`。[构建版本锁](upstream.lock)
- 随应用内置 Pi 作为默认助手，通过 T3 原生 Pi 适配层接入。日常界面使用自有品牌，第三方许可随安装包发布。[运行时设计](doc/plan/03-内置运行时-Pi.md)
- 默认首页以通用任务为主。Pull requests 和 Issues 的入口放到设置内的开发者功能区。[通用任务规划](doc/plan/08-通用任务化改造.md)
- 用 moejs 做插件。待办、日程和 Obsidian 进入首发验收。飞书、企业微信、微信、钉钉是远程连接的候选，具体功能仍待讨论。
- v2 独立搭建。历史 `xtwork_mygo` 只提供可选参考，旧外壳、本地补丁和数据迁移都不构成开工依赖。

## 运行桌面预览

在 macOS 13.5 或更新版本的 Apple Silicon Mac 上安装 Node `26.13.1`、pnpm 和 Go `1.27.3` 或以上版本，再运行：

```sh
node scripts/build-server.mjs
node scripts/build-desktop.mjs --skip-dmg
open '.build/desktop-dist/darwin-arm64/小瞳 Work v2.app'
```

预览经本机 Magpie 连接模型。需要切到 DeepSeek 测试时，给桌面进程传入 `XTWORK_MODEL_UPSTREAM_MODEL=auto/deepseek-v4.1-flash`。构建、模型参数和 R2 更新见 [桌面开发说明](doc/desktop-foundation.md)。

## 数据与隐私

应用关闭使用量遥测和远程诊断导出。待办和对话记录保存在本机。发送消息后，助手会把处理请求所需的对话和工具结果交给已配置的模型服务。更新检查访问小瞳的 R2 发布源。

## 预览交互

[打开交互原型](.smyw/20261119-xtwork-v2/preview.html)，点「演示」。可以试一次聊天记待办、加日程、引用笔记，也可以看开发者入口和远程连接如何收进设置。在「反馈」页可以把批注和结构修改复制回对话。原型使用示例数据。

## 文档地图

- [项目进度与文档目录](doc/README.md)
- [已确认的决策与待定事项](DECISIONS.md)
