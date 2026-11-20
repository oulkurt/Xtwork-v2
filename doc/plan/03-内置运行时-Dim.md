# 03 内置运行时：Dim

> **历史记录（2026-11-20 归档）。** Dim 方向已被 Pi 方案替代。下文保留原先的决策、调研和未执行的验收。现行设计见 [03 内置运行时 · Pi](03-内置运行时-Pi.md) 和 [ADR-009](../decisions/009-default-pi-runtime.md)。

> 回答：内置运行时为什么是 Dim，怎样打包、启动、白标、接模型、升级，它的边界在哪里。
> 【已定】Dim 作为默认运行时，日常界面使用自有品牌，初次使用的模型授权按 Q-03 确定。（2026-11-19）
> 相关：[01 架构](01-架构.md) · [05 插件系统](05-插件系统.md) · [11 风险与待定](11-风险与待定.md)

## 1. Dim 是什么（2026-11-19 核实）

- 仓库 github.com/arcships/dim，MIT，`Copyright (c) 2026 arcships`。仓库创建于 2026-10-13。
- Rust 重写版，README 标注 “Rust alpha”。规划锁定 [`v0.1.0-alpha.25`](https://github.com/arcships/dim/releases/tag/v0.1.0-alpha.25)（2026-11-15），协议细节随该 tag 验证。工作区版本 `0.1.0-alpha.25`，edition 2024，rust-version 1.100。
- 规模：约 71.9 万行 Rust（含测试），另有约 4.3 万行 vendored 代码。
- 主要部件：rutis 插件机制（rquickjs 跑 TS 插件）、Timeline、App Server 守护进程、ACP 网关、aimux 模型宿主。
- 发行物：npm 包 `dimcode-alpha`（命令 `dima`），可执行文件 `dimcode`。GitHub Release 各平台压缩包：

| 平台 | 压缩包 |
|---|---|
| macOS arm64 | 48.2 MB |
| macOS x64 | 51.9 MB |
| Linux arm64 | 50.0 MB |
| Linux x64 | 52.6 MB |
| Windows arm64 | 49.5 MB |
| Windows x64 | 54.1 MB |

**注意两个同名的 “dimcode”：**
- ACP Registry 的 `dimcode` 条目是 `0.5.29`，许可写 “proprietary”，分发方式 `npx dimcode@0.5.29 acp`。这是旧的闭源 TypeScript 版。
- npm 包 `dimcode` 的 `latest` 也是 `0.5.29`（闭源）；`alpha` 标签 `0.1.0-alpha.7` 才指向 MIT 的 arcships/dim。
- **我们只用 GitHub Release 的 MIT Rust 二进制，不用 Registry 条目，不用 npm。**

## 2. 为什么选 Dim【已定】

- MIT 许可，可以白标再分发，不需要 ArcShips 授权。
- 单个原生二进制，不依赖用户机器上的 Node 或 npm。
- 自带 ACP 网关，T3 现有的 ACP 适配层直接可用，不用写新的运行时适配。
- 支持 HTTP MCP，T3 内置 MCP 服务里的工具（包括我们的插件工具）可以直达。
- 有官方的提示覆盖机制（`prompts.base`），白标不需要改源码。

替补：上游自带的 Pi 运行时（`provider-pi`，`@earendil-works/pi-coding-agent`，MIT）。Dim 出现阻断问题时可以临时切换。

## 3. 接入方式【建议】

T3 的 ACP 运行时有两种来源（`packages/provider-acp-registry/src/settings.ts:10`）：“ACP Registry” 和 “Local command”。我们用 Local command：

| 设置字段 | 值 |
|---|---|
| `source` | `local` |
| `commandPath`（界面标签 “Executable override”） | 安装包内的二进制，例如 `<App>/Contents/Resources/runtime/<品牌>-agent` |
| `commandArgs`（隐藏字段） | `acp --home <数据目录>/runtime/dim --model-config <数据目录>/runtime/model.json` |
| `displayName` | 产品给助手起的名字【待定 Q-01】 |

- 启动：T3 直接 spawn，`{ command, args: settings.commandArgs, cwd, env, shell: false }`（`packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:1875`）。不经过 npm。对比：Registry 来源的 npx 运行时在没有 npm 时返回 `runner_unavailable`（同文件 :1230）。
- 写入时机：首次启动时由插件桥或外壳写入 provider 实例设置。`commandArgs` 是隐藏字段，用户在界面上看不到也改不了。【待验证 M0】设置的写入方式：启动前写文件，还是启动后调用服务端设置接口。
- 协议：ACP over stdio。Dim 声明支持 HTTP 和 SSE 形式的 MCP（`crates/dim-acp/src/gateway.rs:378`）。T3 按能力选择传给运行时的 MCP 服务形式（`packages/provider-acp/src/server/AcpSessionRuntime.ts:2170`：支持 acp 用 acpServers，支持 http 用 httpServers，否则用 stdio 桥）。所以 Dim 拿到的是 T3 `/mcp` 的 HTTP 地址和会话令牌。
- 二进制改名是安全的：Dim 用 `std::env::current_exe()` 拉起守护进程（`crates/dim-cli/src/client.rs:39`）。

## 4. 进程、数据与生命周期

- `dimcode acp` 是 ACP 网关。它连接或启动本机的 App Server 守护进程。守护进程监听私有 Unix socket（NDJSON），Windows 上是命名管道。
- `--home` 指向 `<数据目录>/runtime/dim`。产品不读写 `~/.dimcode-alpha`（alpha 版默认）和 `~/.dimcode`（非 alpha 版默认）。用户机器上另装的 Dim 与产品互不影响。
- 退出：【待验证 M0】最后一个 ACP 会话断开后，守护进程是否自动退出。不会的话，外壳在退出流程里按 `--home` 下记录的 PID 结束它。**不按进程名匹配结束进程。**
- 单工作区：Dim 的 ACP 网关只接受一个工作区根目录，`session/new` 的附加目录只能为空或缺省。影响：
  - 免项目对话的根目录是 `<baseDir>/scratch`（`apps/server/src/project/ManagedProjectFolders.ts:70`），满足要求。
  - Obsidian vault 不能作为第二个目录挂进会话。运行时通过插件工具读笔记（见 [06](06-内置插件-待办日程笔记.md)）。这正好符合 Obsidian 插件“不开放任意文件访问”的边界。
- Dim 自己的 TS 插件依赖 Node。`runtime/default-plugins.json` 默认带 `plugin-authoring`（默认启用）和 `light-ocr`（可选）；`node`、`python`、`uv` 三种运行环境都是 `{"source":"download","auto":false}`。CLI 接受的运行环境来源是 `download` 或 `system`。
  - 【建议】v1 关闭 Dim 的 `plugin-authoring`。产品只有一种“插件”概念，就是 moejs 插件。
  - 若保留 Dim 的 TS 插件，把 Node 来源设为 `system`，指向外壳打包的那份 Node（见 [04 §5](04-mygo外壳.md#5-启动服务端建议)）。【待验证】`system` 来源如何指定路径。

## 5. 模型接入【建议，模型来源待定 Q-03】

`model.json` 的格式（`crates/dim-agent-aimux/examples/openai.json`）：

```json
{
  "defaultModel": { "providerId": "openai", "modelId": "gpt-4o" },
  "providers": [
    {
      "id": "openai",
      "kind": "openai-chat",
      "apiKeyEnv": "OPENAI_API_KEY",
      "baseUrl": "https://api.openai.com/v1",
      "models": [
        { "id": "gpt-4o", "contextWindow": 128000, "maxOutputTokens": 16384, "config": { "maxTokens": 4096 } }
      ]
    }
  ]
}
```

- `kind` 可选值（`crates/dim-agent-types/src/model.rs`）：`openai-chat`、`openai-compatible`、`openai-responses`、`xai`、`xai-responses`、`anthropic`、`gemini` 是可评估的选项。该 tag 的模型配置加载会拒绝 `bedrock`。首轮用 `openai-chat`。
- 密钥只通过 `apiKeyEnv` 指定的环境变量传入，`model.json` 里不写密钥。
- `models[].id` 使用网关别名，展示文案由产品翻译。alpha.25 的 ACP 模型选择依赖产品模型目录，单靠 `--model-config` 不能让 T3 切换别名。M0 只配置默认 `standard`，第二个选项待实测。

两种模型来源，产品必须选一种作为默认：

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A 产品提供模型服务 | `baseUrl` 指向我们的云端网关；用户登录后拿到令牌 | 真正开箱即用，用户不用懂 API Key | 需要账号、计费、云端网关的运维 |
| B 用户自带密钥 | 服务端监管本机网关（127.0.0.1）持有用户的密钥（存系统钥匙串），`baseUrl` 指向本机网关，`apiKeyEnv` 传每次启动生成的令牌 | 无云端成本，隐私好 | 首次使用要填 Key，不算“开箱即用” |

两种方案共用配置模板。模型能力、凭据和切换验收见 [13 模型网关](13-模型网关.md)。

## 6. 白标【建议】

| 位置 | Dim 默认表现 | 处理 |
|---|---|---|
| 系统提示开头 | `You are DimAgent. You and the user work together in their workspace toward whatever they're trying to get done.`（`crates/dim-agent-capabilities/src/prompt_sources.rs:153`） | 用 `prompts.base` 整段覆盖 |
| ACP `agentInfo` | 名称 `dimcode`（`crates/dim-acp/src/gateway.rs:1432`） | T3 只读 `agentInfo.version`，不读名称（`provider-acp/src/server/adapter.ts:8490`、`provider-acp-registry/src/server/probe.ts:336`）。界面显示 provider 实例的 `displayName` |
| 运行时选择器 | 列出全部运行时 | 只有一个运行时时隐藏（补丁 P-06） |
| 模型名 | `model.json` 的模型 id | 网关别名 |
| 二进制名 | `dimcode` | 改为 `<品牌>-agent` |
| 数据目录 | `~/.dimcode-alpha` | `--home` 指向产品数据目录 |
| 账号 | “Dim account plugin”，OAuth client ID 在构建时注入 | 不启用 |
| 网络 | 源码中出现 dimagent.com、dimagent.cn（账号登录、设备登录） | 发布前抓包确认没有请求。若官方二进制有请求，改用我们自己从同一 tag 编译的版本（不改源码，只是不注入 client ID） |

遥测：源码里没有找到遥测 SDK，只有模型目录相关文本。发布前仍以抓包为准。

### 6.1 `prompts.base` 覆盖

- 机制：设置源 `prompts`（`crates/dim-app-server/src/prompt_settings.rs:23`，`pub const SOURCE: &str = "prompts";`），只在用户范围生效，可选字段 `base`、`summary`、`skills`，每个字段整段替换对应文本。
- 优先级：factory configuration > 用户设置 > 内置文本。factory configuration 是 Rust 装配层的成员，官方产品配置不设置它，所以用户设置生效。我们不改 Rust 代码，只用用户设置。
- 存储：产品 home 存在 SQLite；文件型 profile 用 home 下的 `prompts.json`。设计文档 `docs/design/appserver/prompt-overrides.md`（状态 Draft #1314，代码已实现）。
- **整段替换的后果：** 内置 base 由 IDENTITY 和 DEFAULTS 组成，DEFAULTS 包括 Safety、Tone and communication、Objectivity、Engineering、Git 五节（Git 节禁止 `git add -A`、force push 等）。覆盖后这些全部失效，由我们的文本负责。
- 我们的 base 文本结构：
  1. 身份：助手名字、定位（通用任务）。
  2. 安全：从上游 Safety 改写，约束一条不少。
  3. 语气与沟通：中文优先、简洁、先给结论。
  4. 客观性：保留上游原意。
  5. 通用任务规则：替代 Engineering 与 Git。文件操作限于工作目录；不擅自删除；对外发送（邮件、IM）之前先确认。开发者功能打开时，追加上游 Engineering 与 Git 两节的原文。
  6. 插件使用规则：何时调用待办、日程、笔记工具，见 [06 §1](06-内置插件-待办日程笔记.md#1-对话怎么决定用哪个插件)。
- Dim 自动附加的事实不受覆盖影响：当天日期（`YYYY-MM-DD`，进程本地时区，`prompt_sources.rs:49`）和 IANA 时区（`prompt_sources.rs:277-278`）。**不包含当前时刻**，所以日程插件要提供“当前时间”工具。
- 维护：每次升级 Dim，脚本从新 tag 提取 IDENTITY 与 DEFAULTS，与上次记录的版本做 diff。有变化就人工审阅，把安全相关的改动合进我们的文本。
- 【待验证 M0】以 `dimcode acp --home …` 启动时，`prompts.base` 是否生效、写入哪里（SQLite 还是 `prompts.json`）。

## 7. 版本与升级【建议】

- 锁定版本：`runtime/dim.lock` 记录 tag、各平台压缩包的 SHA-256、下载地址。
- 升级前的验收（自动化）：
  1. ACP 握手，读到版本号；
  2. `session/new`（免项目目录）；
  3. 发一条提示，收到流式回复；
  4. 调用一个 T3 MCP 工具和一个插件工具；
  5. 触发一次权限请求，在界面上批准与拒绝；
  6. 取消一个进行中的回合；
  7. 退出后没有残留的守护进程；
  8. `prompts.base` 仍然生效（回复里不出现 DimAgent）；
  9. 抓包：没有发往 dimagent.com、dimagent.cn 的请求。
- 绝不分叉 Dim 的约 72 万行 Rust 源码。需要的改动先提给上游。

## 8. 许可与声明

随产品分发：
- Dim 的 `LICENSE`（MIT）。
- `NOTICE`，以及它引用的：Rust 依赖声明 `licenses/RUST-THIRD-PARTY-NOTICES.txt`；aimux（MIT）；vendored 的 xai-org/grok-build 终端库（Apache-2.0，含 Ratatui 署名）；默认 TS 插件的 npm 许可。
- 若分发 Dim 的 web 产物，还要带它的 `THIRD-PARTY-NOTICES.txt`（含 Geist 字体，OFL）。v1 不分发 web 产物。

Dim 的依赖许可白名单（`deny.toml`）：Apache-2.0、BSD-3-Clause、ISC、MIT、MIT-0、Unicode-3.0、Zlib，以及 webpki 相关 crate 的 CDLA-Permissive-2.0。
