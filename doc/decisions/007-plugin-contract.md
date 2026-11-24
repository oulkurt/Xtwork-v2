# ADR-007 · 冻结插件的通信、授权与持久化边界

- **Date** 2026-11-19
- **Status** Proposed
- **Evidence** Confirmed · 已有设计和待办预览。正式兼容范围为 Unknown。

## Context

moejs 和首发内置插件范围已经明确。规划提出由 T3 服务端监管 Go 插件宿主，再由宿主监管每个插件的 worker。开放的宿主能力、插件视图和存储都需要可验证的接口。 [插件系统设计](../plan/05-插件系统.md) · [桌面预览待办](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/doc/desktop-foundation.md#待办插件)

## Problem

内置插件需要稳定地接入对话和界面。需要明确谁能调用工具、谁能读写数据，以及第一版接口是否承诺向后兼容。

## Considered Alternatives

- 由 T3 持有插件桥与宿主，在服务端适配 MCP、上下文和事件，沿用预览验证过的最小通路。
- 延续旧版壳内宿主。当前规划认为会话、工具和持久化集中在 T3，因此倾向服务端侧。
- 视图草案采用独立源承载。预览采用 `srcDoc` 沙箱 iframe，受信父页面转发有限消息。正式槽位和通信接口尚待验收。 [宿主位置依据](../plan/01-架构.md#4-为什么插件宿主挂在服务端下而不是外壳下) · [视图实现](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/overlay/files/apps/web/src/components/plugins/TodoPanel.tsx)

## Decision

候选边界是由 T3 负责会话鉴权、MCP 和 UI 接入，Go 宿主负责解析 manifest、裁决能力、监管 worker 和写入插件数据。规划要求插件通过宿主申请能力，把文件、网络、进程和凭据的原始权限留在受信代码。冻结前确认 PD-01 的协议与升级范围，以及 Q-09、Q-10 的 IM 卡片审批与第三方信任边界（IM 远程连接已由 [ADR-011](011-mingle-im-bridge.md) 独立为 T3 侧受信 `im-bridge` 服务，保持 moejs 沙箱零网络与零凭据边界）。 [插件设计](../plan/05-插件系统.md) · [待决策事项](../../DECISIONS.md#pending-decisions)

## Consequences and Trade-offs

- 预览的 T3 → Go 宿主使用 JSONL 请求，Go 宿主 → worker 使用版本 `1.3` 信封，插件 manifest 的 `api` 是 `1`。内置待办申请 `storage`、`agent.tools`。MCP 调用需要对话上下文。待办创建要求标题，预览的时刻需要搭配本地日期。 [T3 插件桥](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/overlay/files/apps/server/src/mcp/XtworkPluginHost.ts) · [worker 客户端](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/plugin-host/worker_client.go) · [待办 manifest](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/plugins/todo/plugin.json) · [协议 schema](https://github.com/oulkurt/Xtwork-v2/tree/488b882a6e6d24b379384b33eb6cec667574c2f5/plugin-host/protocol/v1) · [MCP 注册](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/overlay/files/apps/server/src/mcp/XtworkPluginMcp.ts)
- 预览面板由不透明源 iframe 发 `postMessage`，父页面核对来源并转发 `list`、`create`。 `GET/POST /api/xtwork/todo` 校验 Bearer 和对应 scope，写入额外要求 `desktop-bootstrap` 主体。 [面板代码](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/overlay/files/apps/web/src/components/plugins/TodoPanel.tsx) · [待办 HTTP 服务](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/overlay/files/apps/server/src/mcp/XtworkPluginService.ts)
- **Confirmed** · 同一 MCP 会话内重发同一创建请求会返回已有待办。重连后发出的新请求和模型重新发起的调用仍算新操作。正式冻结前还需验证权限撤销、笔记出站和第三方隔离。 [待办去重范围](../plugin-tools.md#当前边界) · [插件通路验收](../plan/10-里程碑与验收.md#m2--插件通路)

## Migration Implications

预览待办存入 `userdata/plugins/todo/storage.json`，由 Go 宿主写入独立 JSON 文件。规划提出了另外的目录及注册表布局。冻结时核对预览待办读回、插件数据版本和能力批准记录的承接。 [预览宿主路径](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/overlay/files/apps/server/src/mcp/XtworkPluginHost.ts#L39-L49) · [宿主存储](https://github.com/oulkurt/Xtwork-v2/blob/488b882a6e6d24b379384b33eb6cec667574c2f5/plugin-host/storage.go) · [规划存储](../plan/05-插件系统.md#9-存储)

## Related Decisions

- [ADR-003 · 内置插件与共享上下文](003-bundled-plugins.md)
- [ADR-005 · 独立搭建 v2](005-clean-v2-start.md)
- [ADR-011 · 基于 Mingle 渠道层的 IM 远程连接服务](011-mingle-im-bridge.md)
- [待决策事项](../../DECISIONS.md#pending-decisions)
- [决策索引](../../DECISIONS.md)
