# 插件 v2 第一阶段

插件 v2 使用一个 `plugin.json` 目录格式和两条运行轨道。

## 功能插件

`kind: "functional"` 的插件进入 Go `plugin-host` 的功能注册表。它可以声明 worker、能力、工具和视图。工具继续通过已有的 moejs worker 和 MCP 通路执行，插件存储按插件 ID 隔离。

功能插件在宿主快照中返回 `kind`、能力、工具和视图状态。worker 仍按需启动，外观插件不会进入这个路径。

## 外观插件

`kind: "appearance"` 的插件不启动 worker。Go 宿主只登记它的主题 ID 和 token 快照，`plugins.list` 返回静态信息供 Web 侧使用。

Web 侧 `applyAppearancePluginTheme` 只接受共享主题角色和合法主题颜色，映射到现有 `--app-theme-*` 变量。未知角色或非法颜色会被拒绝。清理函数只移除这次应用的变量。

外观插件没有 iframe、JavaScript、HTML 或任意 CSS 注入入口。

## 插件列表请求

插件宿主的 JSONL 请求 `plugins.list` 返回统一快照。功能插件和外观插件都包含 `pluginId`、`name`、`version`、`kind` 和 `state`。功能插件额外返回 `capabilities`、`tools`、`view`，外观插件额外返回 `theme`。

## 验证

```sh
cd plugin-host
go test ./...
go vet ./...
```

前端主题应用器的测试在生成的 T3 worktree 中运行：

```sh
bun test apps/web/src/appearancePlugin.test.ts
```

## 当前范围

第一阶段已经完成静态注册和应用边界。插件目录安装、Reload、能力重新授权和主题管理页面仍由后续 PR 接入。远程安装、市场、自动升级回滚和动态视觉挂件不在本阶段。
