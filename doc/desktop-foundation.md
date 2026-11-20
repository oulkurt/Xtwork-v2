# 桌面预览

## 构建

首轮是 Apple Silicon macOS 13.5 或更新版本。使用 Node `26.13.1`、pnpm 和 Go `1.27.3` 或以上版本。`upstream.lock` 锁定 T3、mygo 和 Node，`runtime/pi/package-lock.json` 锁定 Pi `1.5.2` 和 npm 依赖。上游源码缓存和带 overlay 的构建副本都在 `.build/`。产品名、图标、版本和更新 URL 由 `overlay/brand/` 提供。小瞳图标沿用旧版项目的自有品牌资产。

```sh
node scripts/build-server.mjs
node scripts/build-desktop.mjs --skip-dmg
open '.build/desktop-dist/darwin-arm64/小瞳 Work v2.app'
```

省略 `--skip-dmg` 可生成 DMG。独立 Node、T3 服务端及前端、Pi 和 moejs 插件宿主一起打包。Pi 通过随包启动器复用 Node。mygo 在本机启动服务端，用同源 WebView 加载界面。应用数据在 `~/Library/Application Support/Xtwork-v2`。用 `XTWORK_DATA_DIR` 可指定独立测试目录。

## 通用任务首页

桌面首启直接打开本机的免项目草稿。点击侧栏「新建对话」或按 `⌘N` 也会进入免项目草稿。按住 Shift 点击「新建对话」，或用草稿里的文件夹选择器，可以在现有文件夹中开始任务。已有对话仍从侧栏打开。

免项目对话共用应用数据目录下的 `scratch`。需要独立保存文件的任务可以选择不同的文件夹。测试首启时，把 `XTWORK_DATA_DIR` 指到 Git 仓库外的空目录。

「设置 → 通用 → 开发者功能」默认关闭，打开后可进入 Pull requests 和 Issues 的完整列表。开关保存在本机服务端设置中。终端、文件夹与编辑器操作继续通过原来的入口访问。

## 测试模型

新会话默认选内置助手。T3 通过 `provider-pi` 和 stdio RPC 启动随包 Pi。`runtime/pi/models.json` 指向服务端本机网关。网关将 `standard` 映射到内测模型。Pi 会话保存在 `runtime/pi/sessions`，桌面服务进程以应用数据目录内的 `workspace` 为工作目录。默认上游是 `http://127.0.0.1:3425/v1` 的 Magpie，默认模型是 `our-free-model/hy4-flash-free`。

在终端设置 `XTWORK_MODEL_UPSTREAM_MODEL=auto/deepseek-v4.1-flash`，再直接运行 `.app/Contents/MacOS/` 下的可执行文件，可用 Magpie 的 DeepSeek 线路。`XTWORK_MODEL_UPSTREAM_URL` 可指定其它 Chat Completions 服务，`XTWORK_MODEL_UPSTREAM_KEY_FILE` 可指向只供服务端读取的密钥文件。凭据和一次性网关令牌保存在进程侧。

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

- 2026-11-20 构建并验证 Apple Silicon `.app` 签名。在 `PATH=/usr/bin:/bin` 下使用包内 Node、Pi 和 Go 宿主运行冒烟。Pi 经 Magpie 的 DeepSeek 线路调用待办工具，重启后在同一线程读回，去重键有效。
- 使用旧 Dim Alpha 冒烟数据副本升级。旧对话保持 Dim 归属，待办和自选模型仍可用，新对话使用 Pi。连续重启两次，迁移后的设置保持一致。
- Pi RPC 实测流式文本增量、取消后上游断开、默认模型发现和 Bash 令牌过滤。锁定 T3 的 `provider-pi` 测试通过 244 项。待办面板的标题栏避开桌面右上角控制区，@ 待办引用会保存 todo-item 记录。桌面取消按钮、交互审批和正式发布仍按 [里程碑](plan/10-里程碑与验收.md) 验收。

### Dim Alpha 历史验收

- 在打包应用中打开待办面板并创建记录，退出重开后记录仍可查看。退出后本机 Node 服务停止。
- Magpie 的 Hy 4 Flash Free 返回免费额度上限。通过 `auto/deepseek-v4.1-flash` 验证了真实 Dim 流式回复，以及经 T3 MCP 创建、重启并查询待办。
- 用本地签名更新源验证下载、安装、重启和拒绝被篡改的归档。R2 的 v2 前缀当前还没有发布清单。
