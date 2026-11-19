# 桌面预览

## 构建

首轮是 Apple Silicon macOS 13.5 或更新版本。使用 Node `26.13.1`、pnpm 和 Go `1.27.3` 或以上版本。`upstream.lock` 锁定 T3、mygo 和 Node，`runtime/dim.lock` 锁定 Dim Rust alpha。上游源码缓存和带 overlay 的构建副本都在 `.build/`。产品名、图标、版本和更新 URL 由 `overlay/brand/` 提供。小瞳图标沿用旧版项目的自有品牌资产。

```sh
node scripts/build-server.mjs
node scripts/build-desktop.mjs --skip-dmg
open '.build/desktop-dist/darwin-arm64/小瞳 Work v2.app'
```

省略 `--skip-dmg` 可生成 DMG。独立 Node、T3 服务端及前端、Dim 和 moejs 插件宿主一起打包。mygo 在本机启动服务端，用同源 WebView 加载界面。应用数据在 `~/Library/Application Support/Xtwork-v2`。用 `XTWORK_DATA_DIR` 可指定独立测试目录。

## 测试模型

新会话默认选内置助手。T3 以 ACP Local command 启动 Dim，服务端在数据目录写入 `runtime/model.json`，把 `standard` 映射到内测模型。默认上游是 `http://127.0.0.1:3425/v1` 的 Magpie，默认模型是 `our-free-model/hy4-flash-free`。

在终端设置 `XTWORK_MODEL_UPSTREAM_MODEL=auto/deepseek-v4.1-flash`，再直接运行 `.app/Contents/MacOS/` 下的可执行文件，可用 Magpie 的 DeepSeek 线路。`XTWORK_MODEL_UPSTREAM_URL` 可指定其它 Chat Completions 服务，`XTWORK_MODEL_UPSTREAM_KEY_FILE` 可指向只供服务端读取的密钥文件。凭据和一次性网关令牌保存在进程侧。

## 待办插件

工具型插件的当前范围、重试幂等规则和验证命令见 [工具型插件](plugin-tools.md)。

待办的 worker 和加载逻辑来自旧 xtwork 的 moejs 插件运行时。T3 启动独立 Go 宿主，经 JSONL 查询和调用工具。Dim 会话通过 T3 的 MCP 服务发现 `todo__create`、`todo__list`。侧栏的「待办」面板经同一宿主读取和创建待办。面板在不透明源 iframe 中运行，宿主页面转发两种固定消息。

验证时在对话里说「记一条待办：周五前发季度报告」，打开「待办」查看结果，重开应用再检查一次。可通过 `XTWORK_PLUGINS_DISABLED=todo` 验证禁用状态。日程、Obsidian 和其它插件后续按工具、界面的顺序接入。

这一版支持创建和查询。聊天创建的记录带对话来源。待办面板每次读取一页，可以用「加载更多」查看后续记录。编辑、删除和提醒留待对应插件能力接入。

可用 Magpie 的 DeepSeek 线路自动验收。脚本启动独立 T3 实例，由默认助手创建一条待办，重启后通过聊天再查一次，并检查 Dim 守护进程退出。

```sh
resources=".build/desktop-dist/$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)/小瞳 Work v2.app/Contents/Resources"
XTWORK_MODEL_UPSTREAM_MODEL=auto/deepseek-v4.1-flash node runtime/smoke-t3.mjs \
  "$resources/server/dist/bin.mjs" "$resources/runtime/dimcode" \
  "$resources/plugin-host/xtwork-plugin-host"
```

## 更新与遥测

桌面构建使用旧 R2 域名的独立前缀 `https://xiaotongwork.skykale.cn/xtwork-v2/updates`。启用签名更新时，mygo 从 `update-darwin-arm64.json` 检查版本并校验更新包签名。开发包省略签名对时，更新在设置中显示为不可用。

发布环境提供 `XTWORK_UPDATE_PUBLIC_KEY` 和 `MYGO_UPDATER_PRIVATE_KEY`，再运行 `node scripts/build-desktop.mjs` 生成签名更新清单及归档。对外包通过 `XTWORK_MACOS_SIGN_IDENTITY` 指定 Developer ID。发布到旧 R2 的 v2 前缀依赖 AWS CLI 和 `R2_ACCOUNT_ID`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。更新 `brand.json` 版本后传 `--upload`，脚本先验证安装包，再上传版本归档，最后更新发布清单。

桌面服务端的产品分析服务使用空实现，WebView 关闭 relay 遥测。日志和本地诊断留在应用数据目录。模型请求按上面的模型配置发送。

## 首轮验收

- 在打包应用中打开待办面板并创建记录，退出重开后记录仍可查看。退出后本机 Node 服务停止。
- Magpie 的 Hy 4 Flash Free 返回免费额度上限。通过 `auto/deepseek-v4.1-flash` 验证了真实 Dim 流式回复，以及经 T3 MCP 创建、重启并查询待办。
- 用本地签名更新源验证下载、安装、重启和拒绝被篡改的归档。R2 的 v2 前缀当前还没有发布清单。
