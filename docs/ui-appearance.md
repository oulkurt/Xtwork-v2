# 界面配色

小瞳 Work 默认使用 **纸白**。在「设置 → 外观」还可以选择 **花瓣、草甸、潮汐、暖杏、暮色**。每套都有浅色和深色，支持跟随系统。升级后，已有的内置主题选择会自动对应到新配色。

## 渐变、悬浮卡片与色板

内置配色沿用 Kero 2.1.35 的底色、色标和柔光。窗口与侧栏作为底层（Base Layer）使用从上到下的 Oklab 渐变并在右上角叠加斜向柔光；侧栏透出渐变，右侧主工作区 `[data-slot="sidebar-inset"]` 与设置内容区作为独立内容层（Content Layer）将局部 `--background` 映射到主题实色 `surface`、将嵌套 `--card` 抬升至 `surfaceRaised`，同时保持 `[data-chat-header]` 与设置顶栏透明，避免子容器用顶部渐变色标覆盖卡片底色。浅色次要文字略加深，按钮会根据深浅模式选用便于阅读的文字颜色。渐变和色板预览取自同一份配色数据。测试核对启动画面的配色与运行时一致。自定义主题、环境主题与外观插件会自动剥离内置窗口渐变，释放插件后恢复原有渐变状态。

桌面宽度（`>= 768px`，窗口最小宽度同步为 `768px`）下，右侧主工作区在侧栏展开态保持上/右/下 `8px` 留白（左侧贴合透明侧栏），在侧栏折叠态保持四边对称 `8px` 留白的整体悬浮卡片形态：
- **边界与组合海拔**：浅色模式采用 `background-clip: padding-box` 下的半透明黑细线与轻环境影，深色模式采用半透明浅色边框、顶边高光边（`::after` 顶亮边缘）与三层紧致落影，并继续响应高对比度设置（`--appearance-contrast-*`）。
- **同心圆角与标题栏中轴对齐**：`shell/preload.js` 在启动（若根节点尚未就绪则延后到一次性 `DOMContentLoaded`）、`xtwork:fullscreen`、`xtwork:window-state`（最大化/还原）与窗口尺寸变化时实时同步 `--xtwork-window-radius`（将合法的 `0` 窗口圆角明确写为 `0px`，仅非数值或负值时回退默认 `22px`），卡片圆角按 `clamp(10px, calc(var(--xtwork-window-radius, 22px) - 8px), 18px)` 计算；`shell/main.go` 将 `TitleBarHeight` 设为 `52`、macOS `TrafficLightPosition` 置于 `(18, 19)`，与侧栏 `52px` 顶栏及卡片内 `34px` 顶栏共享同一水平中轴线（`26px`），在较矮的 `40px` WCO 标题栏下顶部留白自动收敛至 `5px` 以保持卡片顶栏至少 `28px` 且居中对齐；窗口层与聊天/右面板标题栏统一消费 WCO 与 `--mygo-titlebar-inset-right` 右侧预留，`AppRouteModal` 与窄屏抽屉 `RightPanelSheet` 同步纳入 `--mygo-titlebar-height` / `--mygo-titlebar-controls-bottom` 顶部留白以避免 Windows 原生按钮遮挡；顶部留白通过真实 DOM 节点 `[data-xtwork-window-drag-strip].drag-region` 承载 MyGo/Electron 窗口拖动，聊天顶栏与右侧面板共用 `[data-workspace-titlebar-no-drag]` 对齐 `52px` 防拖动护盾。
- **正交状态标记与声明式图层合成**：根元素将语义令牌激活标记（`data-xtwork-theme-tokens`）、内置渐变/悬浮卡标记（`data-xtwork-wash`）与底层主题/预览身份（`data-theme-id`）拆为 3 个正交维度。无论是在默认纸白（浅/深色）、内置主题、自定义主题（含 ID 为 `default` 的自定义主题，按来源判定不套用纸白渐变）还是主题编辑器预览（`__preview`）上叠加一个或多个外观插件，语义颜色映射、透明 `[data-chat-header]` 顶栏、代码块表面和 `syncBrowserChromeTheme()` 均由 `data-xtwork-theme-tokens` 统一驱动；插件与基础主题写入共用声明式图层投影栈，释放插件（含乱序/重复调用 `dispose()`）时始终恢复**最新**基础主题色板、顶栏底色与对应渐变状态。

色板是圆角矩形，预览同一套主题的背景、侧栏、带细线边界的悬浮正文卡、消息和按钮。桌面端从 mygo 读取主窗口圆角，浏览器使用 18px 的圆角。一次可选整套主题，也可单独指定浅色或深色。

## 界面品牌

桌面和 Web 的用户可见文案使用小瞳 Work 的品牌与命名。借鉴外部项目的设计时，按小瞳 Work 的产品语境为主题和界面元素命名。来源信息放在源码或开源许可中。

配色与悬浮卡边缘参考 [Kero 2.1.35 的主题与海拔实现](https://github.com/egoist/kero/blob/v2.1.35/theme.go)。随构建分发的许可见 [LICENSE.Kero](../overlay/files/apps/web/public/LICENSE.Kero)。

## 验证

在仓库根目录先运行 `node scripts/prepare.mjs` 应用配色补丁，再顺序执行下面命令，核对主题显示名称、启动渐变、相邻色边界对比度、悬浮卡片表面/中轴线/同心圆角/折叠态、Windows MyGo 标题栏避让及桌面壳窗口参数：

```sh
(cd .build/t3code/apps/web && pnpm exec vp test run --project unit src/themePalette.test.ts src/themeBoot.test.ts src/appearancePlugin.test.ts)
(cd .build/t3code/apps/web && pnpm exec vp test run --project browser src/themePalette.browser.test.ts src/components/leader/LeaderUi.browser.test.tsx src/components/WindowsMyGoTitlebar.browser.test.tsx)
(cd shell && go test ./...)
```
