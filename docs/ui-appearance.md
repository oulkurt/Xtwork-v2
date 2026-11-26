# 界面配色

小瞳 Work 默认使用 **纸白**。在「设置 → 外观」还可以选择 **花瓣、草甸、潮汐、暖杏、暮色**。每套都有浅色和深色，支持跟随系统。升级后，已有的内置主题选择会自动对应到新配色。

## 渐变、悬浮卡片与色板

内置配色沿用 Kero 2.1.35 的底色、色标和柔光。窗口与侧栏作为底层（Base Layer）使用从上到下的 Oklab 渐变并在右上角叠加斜向柔光；侧栏透出渐变，右侧主工作区 `[data-slot="sidebar-inset"]` 与设置内容区作为独立内容层（Content Layer）将局部 `--background` 映射到主题实色 `surface`、将嵌套 `--card` 抬升至 `surfaceRaised`，同时保持 `[data-chat-header]` 与设置顶栏透明，避免子容器用顶部渐变色标覆盖卡片底色。浅色次要文字略加深，按钮会根据深浅模式选用便于阅读的文字颜色。渐变和色板预览取自同一份配色数据。测试核对启动画面的配色与运行时一致。自定义主题、环境主题与外观插件会自动剥离内置窗口渐变，释放插件后恢复原有渐变状态。

桌面宽度（`>= 768px`，窗口最小宽度同步为 `768px`）下，右侧主工作区在侧栏展开态保持上/右/下 `8px` 留白（左侧贴合透明侧栏），在侧栏折叠态保持四边对称 `8px` 留白的整体悬浮卡片形态：
- **边界与组合海拔**：浅色模式采用 `background-clip: padding-box` 下的半透明黑细线与轻环境影，深色模式采用半透明浅色边框、顶边高光边（`::after` 顶亮边缘）与三层紧致落影，并继续响应高对比度设置（`--appearance-contrast-*`）。
- **同心圆角与标题栏中轴对齐**：`shell/preload.js` 在启动及 `xtwork:fullscreen` 切换时实时同步 `--xtwork-window-radius`，卡片圆角按 `clamp(10px, calc(var(--xtwork-window-radius, 22px) - 8px), 18px)` 计算；`shell/main.go` 将 `TitleBarHeight` 设为 `52`、macOS `TrafficLightPosition` 置于 `(18, 19)`，与侧栏 `52px` 顶栏及卡片内 `34px` 顶栏共享同一水平中轴线（`26px`）；窗口层统一按 WCO、`--mygo-titlebar-inset-*` 与卡片留白取最大值计算左右控制区预留；顶部 `8px` 留白通过真实 DOM 节点 `[data-xtwork-window-drag-strip].drag-region` 承载 MyGo/Electron 窗口拖动，聊天顶栏与右侧面板共用 `[data-workspace-titlebar-no-drag]` 对齐 `52px` 防拖动护盾。
- **纸白同步**：默认纸白主题在未设置 `data-theme-id` 时仍通过 `data-xtwork-wash` 写入 `--app-chrome-background` 作为浏览器/壳层底色，避免回写卡片白色。

色板是圆角矩形，预览同一套主题的背景、侧栏、带细线边界的悬浮正文卡、消息和按钮。桌面端从 mygo 读取主窗口圆角，浏览器使用 18px 的圆角。一次可选整套主题，也可单独指定浅色或深色。

## 界面品牌

桌面和 Web 的用户可见文案使用小瞳 Work 的品牌与命名。借鉴外部项目的设计时，按小瞳 Work 的产品语境为主题和界面元素命名。来源信息放在源码或开源许可中。

配色与悬浮卡边缘参考 [Kero 2.1.35 的主题与海拔实现](https://github.com/egoist/kero/blob/v2.1.35/theme.go)。随构建分发的许可见 [LICENSE.Kero](../overlay/files/apps/web/public/LICENSE.Kero)。

## 验证

运行 `node scripts/prepare.mjs` 应用配色补丁。然后在 `.build/t3code/apps/web` 与 `shell/` 运行下面的测试，核对主题显示名称、启动渐变、相邻色边界对比度、悬浮卡片表面/中轴线/同心圆角/折叠态及桌面壳窗口参数。

```sh
pnpm exec vp test run --project unit src/themePalette.test.ts src/themeBoot.test.ts src/appearancePlugin.test.ts
pnpm exec vp test run --project browser src/themePalette.browser.test.ts
(cd shell && go test ./...)
```
