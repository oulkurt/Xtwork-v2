# 界面配色

小瞳 Work 默认使用 **纸白**。在「设置 → 外观」还可以选择 **花瓣、草甸、潮汐、暖杏、暮色**。每套都有浅色和深色，支持跟随系统。升级后，已有的内置主题选择会自动对应到新配色。

## 渐变和色板

内置配色沿用 Kero 2.1.35 的底色、色标和柔光。窗口用从上到下的 Oklab 渐变，右上角叠加斜向柔光。侧栏透出渐变，正文、设置内容和终端使用各自的主题实色。浅色次要文字略加深，按钮会根据深浅模式选用便于阅读的文字颜色。渐变和色板预览取自同一份配色数据。测试核对启动画面的配色与运行时一致。自定义和环境主题继续使用各自保存的配色与背景。

色板是圆角矩形，预览同一套主题的背景、侧栏、正文、消息和按钮。桌面端从 mygo 读取主窗口圆角，浏览器使用 18px 的圆角。一次可选整套主题，也可单独指定浅色或深色。

## 界面品牌

桌面和 Web 的用户可见文案使用小瞳 Work 的品牌与命名。借鉴外部项目的设计时，按小瞳 Work 的产品语境为主题和界面元素命名。来源信息放在源码或开源许可中。

配色来自 [Kero 2.1.35 的主题实现](https://github.com/egoist/kero/blob/v2.1.35/theme.go)。随构建分发的许可见 [LICENSE.Kero](../overlay/files/apps/web/public/LICENSE.Kero)。

## 验证

运行 `node scripts/prepare.mjs` 应用配色补丁。然后在 `.build/t3code/apps/web` 运行下面的测试，核对主题显示名称、启动渐变、实际 CSS 颜色和主题编辑器的预览切换。

```sh
pnpm exec vp test run --project unit src/themePalette.test.ts src/themeBoot.test.ts
pnpm exec vp test run --project browser src/themePalette.browser.test.ts
```
