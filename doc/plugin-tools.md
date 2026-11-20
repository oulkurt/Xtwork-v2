# 工具型插件

工具型插件用 `plugin.json` 的 `contributes.tools` 声明工具和输入 JSON Schema，申请 `agent.tools`，并在 worker 中导出 `tools` 对象。`contributes.views` 可省略。Go 宿主校验清单后按需启动 moejs worker，T3 将工具注册到 MCP。工具名为 `<plugin-id>__<tool-name>`，插件 ID 中的连字符会替换为下划线。

## 已接入范围

- `todo__create` 创建待办，保存标题、备注、分组、截止日期、时间和优先级。
- `todo__list` 按全部、今天、本周、已完成或逾期筛选待办，支持分组、分页和数量限制。默认把长备注压缩为预览，面板读取时保留完整备注以支持编辑。
- `todo__update` 修改已有待办的标题、备注、分组、截止日期、时间或优先级。
- `todo__complete` 完成或重新打开待办。
- `todo__delete` 删除待办。
- 待办工具和面板使用同一份插件存储，宿主重启后仍可读回。
- MCP 工具只在本机对话会话中可调用。禁用 `todo` 后不会注册工具，也不会接受调用。
- Pi 在同一个 MCP 会话重发同一条 JSON-RPC 请求时，`todo__create` 返回原来的待办。T3 将会话、工具名和请求 ID 转成 `context.operationKey`。待办用这个键生成记录 ID，只写一次。新请求可以创建同名待办。

## 当前边界

- 本阶段承诺待办的创建、查询、修改、完成和删除。提醒、日程和 Obsidian 工具后续接入。
- 去重适用于带 MCP 会话 ID 的请求重发。重连后的新请求和模型重新发起的调用各算一次新操作。
- `confirm: true` 工具暂时不会加载，因为 MCP 确认卡片和拒绝后的恢复流程还没有接通。
- 工具调用结果向 MCP 返回文本。对象结果也会作为结构化 JSON 返回。

## 验证

从仓库根目录进入 `plugin-host` 运行测试。

```sh
cd plugin-host
go vet ./...
go test -race ./...
```

集成测试覆盖纯工具插件注册、worker 调用、重试、同名新建、持久化、禁用和分页。桌面文档中的 smoke 命令会用内置 Pi 创建待办，检查 MCP 生成的操作键，再重启服务并在原线程读回该记录。 [桌面预览](desktop-foundation.md#待办插件)
