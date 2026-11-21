# 界面系统

本目录写正式程序现在的界面规则，按主题分文件。体验基线是认可原型 `design/prototype/reference-browser/`（固定提交 `bd8aea44`）及其 [设计说明](../prototype/reference-browser/DESIGN-NOTES.md)；这里只补正式程序需要、原型没有覆盖的部分。

- 数值的唯一来源是 `src/styles/tokens.css`。文档与它对不上时以 `tokens.css` 为准，并在同一个 PR 里改文档。
- 文档与代码对不上时，先查清哪边对：代码对就改文档，代码错就开工单，不在文档里留两种说法。
- 每份文档只写现在的规则，不写改版经过。工单编号只在读者需要去看那个工单时写。
- 同一样东西只用一个叫法，见 [interface-terms.md](interface-terms.md)“界面部件”。

## 文件

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| [scales.md](scales.md) | 字号、圆角、控件高度、层级、不可用、半透明面板、动效的档位；共用类清单；样式写在哪里 | 写样式前取数值；加样式表或共用类 |
| [tokens.md](tokens.md) | 令牌来源、日夜写法、强调 / 人工 / 警告三种颜色、焦点环 | 加或改颜色令牌；写焦点样式 |
| [components.md](components.md) | 组件库的用法、“界面 → 组件”对照、各组件的规格 | 选组件；改菜单、设置、详情面板、轻提示、标签分组 |
| [visual-and-motion.md](visual-and-motion.md) | 颜色与字、层次、圆角、控件文字居中、图片区、空状态、转圈、标签块、动效 | 改视觉或动画 |
| [buttons-and-dock.md](buttons-and-dock.md) | 导入、精确查找、图片大小浮岛、滑条、按钮层级与质感、Dock | 改按钮、工具条、浮岛 |
| [window-frame-and-sidebar.md](window-frame-and-sidebar.md) | 自绘窗口框架、顶栏、侧栏的三段与三种行 | 改窗口外框、标题栏、侧栏 |
| [main-window-material.md](main-window-material.md) | 桌面与纸、输入框的槽、顶栏、侧栏的文件夹视图、详情面板的空状态 | 改主窗口外观、顶栏、侧栏、输入框 |
| [interaction-flows.md](interaction-flows.md) | 图库切换、侧栏、导入、提示、设置、图集、图片墙底部的浮动件与通知 | 改这些操作的流程 |
| [interface-text-rules.md](interface-text-rules.md) | 界面文字的名称、描述与用词规则 | 写或审界面文字 |
| [interface-terms.md](interface-terms.md) | 该用的词与不用的词，按主题列 | 给按钮、菜单、提示起名或改词；写设计文档 |
| [brand-invariants.md](brand-invariants.md) | logo、封印书等不能改的部分 | 动到品牌元素 |

## 预览

`preview/` 是改版预览截图（1440 × 900，静态）。它们是负责人认可视觉方向时的参照，不是正式程序的证据；和现在的规则对不上时以本目录的文档为准。
