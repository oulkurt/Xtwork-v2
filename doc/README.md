# 小瞳 Work v2 文档

## 当前进度

**Apple Silicon macOS Alpha 预览（`0.1.0-alpha.1`）。** 截至 2026-11-20，已实现桌面底座、Pi 内置助手、待办管理、工具型插件和六套渐变配色。正式发布仍待验收。 [桌面底座](https://github.com/oulkurt/Xtwork-v2/pull/1) · [插件与去重](https://github.com/oulkurt/Xtwork-v2/pull/2) · [待办面板](https://github.com/oulkurt/Xtwork-v2/pull/6) · [界面配色](ui-appearance.md)

| 里程碑 | 现状 | 还缺什么 |
|---|---|---|
| M0 桌面、T3、Pi | 已验证 Pi 随包启动、待办创建和原对话续聊，旧 Alpha 冒烟数据升级通过。 [桌面验收](desktop-foundation.md#验收) | 桌面取消按钮与交互审批 |
| M1 通用任务桌面版 | 桌面首启进入本机免项目对话。开发者功能默认关闭，开启后可从设置或 `⌘K` 访问 PR 和 Issues。普通模式保留改动对比。 | 干净机器安装和首发模型授权。 [桌面预览](desktop-foundation.md#通用任务首页) |
| M2 插件通路 | 待办工具、面板、@ 上下文和撤销已接通。Go 宿主、MCP 工具和插件禁用可用。 [工具型插件](plugin-tools.md) | `@` 上下文、交互审批与撤销、公开插件契约冻结。插件 v2 第一阶段正在实现。 |
| M3 内置插件 | 部分实现。待办可创建、查询、编辑、完成、重开和删除，重启后可读回。 | 待办撤销与提醒、日程、Obsidian 引用。 [工具型插件](plugin-tools.md) · [内置插件规划](plan/06-内置插件-待办日程笔记.md) |
| M4 远程连接 | 架构与首发范围已定（[ADR-011](decisions/011-mingle-im-bridge.md)）。 | 实现 `im-bridge` 底座，在飞书、企微真机验收绑定、私聊与群聊 `@` 闭环，在个人微信（iLink）验收私聊闭环与合规边界。 [远程连接规划](plan/07-远程连接插件.md) |
| M5 发布候选 | 已有 macOS 打包、签名更新和 R2 上传脚本。本地签名更新有历史验收记录。 | 正式签名公证、发布渠道及干净环境的安装升级验收。Windows 和其他平台按首发范围另行验收。 [发布规划](plan/09-品牌与发布.md) |

**首发模型**　仍待确定由产品提供还是用户自带 Key。 [交互原型](../.smyw/20261119-xtwork-v2/preview.html) · [Q-03 模型授权](../DECISIONS.md#pending-decisions)

**验收记录**　桌面验收包含 Pi 打包、真实模型与待办。原桌面底座的签名更新结果另见历史记录。待办面板已在 Chromium 和 WebKit 跑通新增、筛选、编辑、完成、重开和删除。 [桌面验收](desktop-foundation.md#验收) · [待办面板验收](https://github.com/oulkurt/Xtwork-v2/pull/6)

## 当前运行进程

mygo 外壳管理本机 T3 Node 服务，WebView 加载服务提供的 React 界面。T3 的原生适配层通过 RPC 启动随包 Pi。Pi 用会话级 MCP 调待办，通过 T3 的 JSONL 插件桥送到 Go 宿主和 moejs worker。Pi 经本机网关连接 Magpie 或配置的模型服务。 [桌面外壳](../shell/main.go) · [插件宿主接入](../overlay/files/apps/server/src/mcp/XtworkPluginHost.ts) · [模型网关](../runtime/gateway.ts)

## 实现说明

- [桌面预览、构建与更新](desktop-foundation.md)
- [工具型插件和待办](plugin-tools.md)
- [插件 v2 第一阶段](plugin-v2.md)
- [界面配色](ui-appearance.md)

## 设计与验收

| 主题 | 文档 |
|---|---|
| 架构和依赖 | [01 架构](plan/01-架构.md) · [02 上游与改造层](plan/02-上游与改造层.md) |
| 运行时、外壳与模型 | [03 内置运行时 · Pi](plan/03-内置运行时-Pi.md) · [04 mygo 外壳](plan/04-mygo外壳.md) · [13 模型网关](plan/13-模型网关.md) |
| 插件与通用任务 | [05 插件系统](plan/05-插件系统.md) · [06 内置插件](plan/06-内置插件-待办日程笔记.md) · [07 远程连接](plan/07-远程连接插件.md) · [08 通用任务](plan/08-通用任务化改造.md) |
| 品牌、发布与迁移 | [09 品牌与发布](plan/09-品牌与发布.md) · [12 从 xtwork 迁移](plan/12-从xtwork迁移.md) |
| 验收、风险和依据 | [10 里程碑与验收](plan/10-里程碑与验收.md) · [11 风险与待定](plan/11-风险与待定.md) · [附录 已核实事实](plan/附录-已核实事实.md) |
| 已确认方向与待决策 | [决策索引](../DECISIONS.md) · [工程决策记录](decisions/README.md) |

插件 v2 的已确认协议见 [ADR-010](decisions/010-plugin-v2-runtime.md)，基于 Mingle 渠道层与伴侣范式的 IM 远程连接服务见 [ADR-011](decisions/011-mingle-im-bridge.md)。

历史资料见 [Dim 架构](plan/03-内置运行时-Dim.md) 和 [Dim ACP 未实施待办](plan/dim-acp-flavor-todo.md)。

### 标记约定

- **【已定】** 已确认的产品方向。
- **【建议】** 可按验收结果调整的设计。
- **【待定】** 需要确认范围或方案。
- **【待验证】** 仍需运行实际应用或测试环境。

功能完成后，在 `doc/` 更新对应的实现与验证说明，并同步上面的进度表。
