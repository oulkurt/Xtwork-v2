# 界面配色

小瞳 Work 默认使用 **纸白**。在「设置 → 外观」还可以选择 **花瓣、草甸、潮汐、暖杏、暮色**。每套都有浅色和深色，支持跟随系统。升级后，已有的内置主题选择会自动对应到新配色。

## 界面品牌

桌面和 Web 的用户可见文案使用小瞳 Work 的品牌与命名。借鉴外部项目的设计时，按小瞳 Work 的产品语境为主题和界面元素命名。来源信息放在源码或开源许可中。

## 验证

运行 `node scripts/prepare.mjs` 应用配色补丁。然后在 `.build/t3code/apps/web` 运行下面的测试，核对主题显示名称、启动画面和实际 CSS 颜色。

```sh
pnpm exec vp test run --project unit src/themePalette.test.ts src/themeBoot.test.ts
pnpm exec vp test run --project browser src/themePalette.browser.test.ts
```
