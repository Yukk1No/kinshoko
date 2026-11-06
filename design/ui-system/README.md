# 界面系统

**状态：方向已认可 · 2026-10-10；设计系统 v3 · 2026-10-23。** 负责人认可了视觉方向与改版预览（`preview/`）。v2 把字号收为 16 / 13 / 12 三档、圆角改为同心、去掉中点分隔与解释性描述；v3 把颜色从 v2 试用的 Radix Colors 换回原型的米黄纸底与墨紫字，只为文字对比度调深了几个值。颜色、圆角与动效令牌以 `src/styles/tokens.css` 为准（见 [tokens-and-components.md](tokens-and-components.md)“令牌来源”）。本目录各文件与 v3 冲突处以 v3 为准。

本目录记录正式程序的界面规则，按主题分文件。体验基线仍是认可原型 `design/prototype/reference-browser/`（固定提交 `bd8aea44`）及其 [设计说明](../prototype/reference-browser/DESIGN-NOTES.md)；这些文件只补正式程序需要、原型没有覆盖的部分。

## 文件

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| [tokens-and-components.md](tokens-and-components.md) | 令牌来源、组件库选型与组件对照 | 写样式、选组件 |
| [brand-invariants.md](brand-invariants.md) | logo、封印书等不能改的部分 | 动到品牌元素 |
| [window-frame-and-sidebar.md](window-frame-and-sidebar.md) | 自绘窗口框架、侧栏布局 | 改窗口外框、标题栏、侧栏 |
| [buttons-and-dock.md](buttons-and-dock.md) | 按钮、Dock 的样式与放置 | 改按钮、工具条、浮岛 |
| [visual-and-motion.md](visual-and-motion.md) | 字号、颜色、圆角、动效 | 改视觉或动画 |
| [interface-text-rules.md](interface-text-rules.md) | 界面文字的名称、描述与用词规则 | 写或审界面文字 |
| [copy-map.md](copy-map.md) | 逐条文案与操作改写对照 | 查某个词或流程改成了什么 |

## 预览

`preview/` 为改版预览截图（1440 × 900，静态，文案为定稿方向）。预览源码在 T20 工作树的 ignored `work/ui-preview/`，不是正式程序证据。
