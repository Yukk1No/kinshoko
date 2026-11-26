# 档位、层级与共用类

这份文件是写样式时取数值的地方：字号、圆角、控件高度、层级、不可用、半透明面板、动效各有哪几档，共用类有哪些，样式写在哪个文件里。颜色令牌见 [tokens.md](tokens.md)。

数值的唯一来源是 `src/styles/tokens.css`。这里只写有哪几档、各用在哪里；两边对不上时以 `tokens.css` 为准，并在同一个 PR 里改这份文件。

## 字号

只有三档：16、13、12 px。

| 档 | 用在哪里 |
| --- | --- |
| 16 | 页面与对话框标题、侧栏标题 |
| 13 | 正文、控件文字、菜单行 |
| 12 | 分组名、说明、角标、快捷键提示 |

菜单行与下拉候选都是 13 px，菜单标题与分组名共用 `.k-section-label`（12 px），没有字号例外。

## 圆角

都在 4 px 网格上，由外向内排：内圆角 = 外圆角 − 内边距，最小 4。

| 令牌 | 值 | 典型用处 |
| --- | --- | --- |
| `--r-xs` | 4 | 最内层的小块 |
| `--r-s` | 8 | 菜单项、分段项、开关 |
| `--r` | 12 | 输入框、按钮、面板、浮层 |
| `--r-l` | 16 | 轻提示、任务卡 |
| `--r-xl` | 20 | dock、设置组 |
| `--r-2xl` | 32 | 对话框 |
| `--r-pill` | 999 | 胶囊、圆形 |

## 控件高度

| 令牌 | 值 | 用在哪里 |
| --- | --- | --- |
| `--h-sm` | 28 | 紧凑的按钮与图标按钮、分段项 |
| `--h` | 32 | 按钮、输入框、下拉、设置里的查找框 |
| `--h-lg` | 40 | 顶栏查找框、顶栏导入按钮 |

按钮、图标按钮、输入框、下拉、分段项、dock 项、图标轨按钮的高度只取这三档。胶囊（22）、标签（26 / 28）、侧栏行（30）、角标不是控件，不在此列。

## 层级

10 以上的 `z-index` 只用下表的令牌，数值从下往上排。组件内部 1–9 的叠放不用令牌，留在组件自己的样式表里。

| 层 | 值 | 令牌 | 用在哪里 |
| --- | --- | --- | --- |
| 窄窗口浮出侧栏的遮罩 | 29 | `--z-pane-scrim` | `.pane-scrim`（`src/shell/sidebar.css`） |
| 窄窗口浮出的侧栏 | 30 | `--z-pane-float` | `.sidebar-slot[data-float]`（同上） |
| 界面特效层 | 38 | `--z-fx` | `.fx-layer`（`src/shell/seal-fx.css`） |
| 任务卡 | 50 | `--z-task` | `.k-task-cards`（`src/ui/dialogs-tasks.css`） |
| 拖入提示 | 80 | `--z-drop` | `.k-drop-hint`（同上） |
| 对话框遮罩 | 90 | `--z-backdrop` | `.k-backdrop`（`src/ui/ui-dock.css`） |
| 对话框 | 91 | `--z-dialog` | `.k-dialog`（同上） |
| 浮层（菜单、下拉、气泡、悬停提示） | 95 | `--z-popup` | `.k-positioner`（`src/ui/ui.css`） |
| 轻提示 | 200（每条 `100 − 序号` 叠在容器内） | `--z-toast` | `.k-toasts`（`src/ui/toast.css`） |
| 启动画面 | 1000 | `--z-splash` | `.startup-splash`（`src/shell/startup-splash.css`） |
| 菜单调试面板（只在开发时出现） | 9999 | `--z-debug` | `.k-menu-debug`（`src/ui/menu.css`） |

浮层高于对话框，所以对话框里的下拉能盖住对话框；轻提示高于一切常驻界面。新加一层时先找能不能落进已有的一层，确实不行再在表里插一行。

## 不可用

一个值：透明度 0.5，令牌 `--disabled-opacity`。`:disabled`、`[data-disabled]`、`[aria-disabled]` 的规则都用它，不按地方另调深浅。

## 半透明浮动面板

一种配方：底色 `--glass-bg`（`--surface` 的 86%），模糊 `--glass-blur`（`blur(18px) saturate(1.2)`）。

用它的：dock、dock 托盘、图片大小浮岛、打标进度、轻提示、任务卡。钉图上的墨色提示条（`src/desktop/capture.css`）只用模糊，底色仍是墨色。

菜单、下拉、可搜索下拉与气泡统一用 `.k-popup`：12 圆角、6 内边距、1 px `--line` 描边、`--surface` 底、`--shadow-pop` 投影，模糊取 `--popup-blur`（`blur(18px) saturate(135%)`）。这一外形与半透明浮动面板分开。

## 动效

时长与曲线不另写数值，只用下面这些。系统开启减弱动效时，样式里的时长令牌都归零，脚本里的过渡读 `src/ui/reducedMotion.ts` 直接到终态。

**样式表令牌**（`tokens.css`）

| 令牌 | 值 | 用在哪里 |
| --- | --- | --- |
| `--t-fast` | 120 ms | 悬停、按下这类小的状态变化 |
| `--t` | 200 ms | 一般的状态变化；图标轨图标移出 |
| `--t-slow` | 260 ms | 指示块滑到新位置、面板宽度 |
| `--t-pop` | 220 ms | 浮层进出 |
| `--t-icon` | 420 ms | 图标轨图标的悬停动作 |
| `--ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | 不带回弹的过渡 |
| `--spring` | `cubic-bezier(0.2, 0.9, 0.25, 1.05)` | 带一点回弹的过渡 |

**有名字的单项时长**（`tokens.css`，只用在登记的那一处）

| 令牌 | 值 | 用在哪里 |
| --- | --- | --- |
| `--t-progress` | 600 ms | 打标进度环的弧长变化（`src/wall/wall-floats.css`） |
| `--t-stagger` | 18 ms | 侧栏目录展开时各行依次落下，每行晚这么多（`src/shell/sidebar.css`） |
| `--t-toast` | 400 ms | 轻提示叠放与展开时的位移（`src/ui/toast.css`） |
| `--t-splash` | 360 ms | 启动画面退场时标志与文字淡出（`src/shell/startup-splash.css`） |
| `--t-splash-hold` | 250 ms | 启动画面退场前标志多停的一会儿（同上） |

**脚本里的过渡**都从 `src/ui/motion.ts` 引用，不另写数值：

| 名称 | 档位 | 用在哪里 |
| --- | --- | --- |
| `arcSpring` | snappy 260 ms、morph 420 ms、smooth 400 ms | dock、悬浮栏、图片大小浮岛、对话框高度、查看器飞入 |
| `spring` | fast 80、moderate 160、slow 240 ms，只用 moderate | `FluidList` 的悬停高亮 |

**例外**

- 级联菜单用 `src/ui/menu/timing.ts` 的时间常量与回弹（淡入 170、位移 360 ms），退场只淡出，不并入通用档位。
- 封印与释放演出、安全模式遮蔽是品牌不变项，数值不动：卡片遮蔽的过渡在 `src/wall/wall.css`，演出层 `.fx-*` 在 `src/shell/seal-fx.css`。
- 循环播放的动画（呼吸、转圈）有自己的周期。

## 共用类

界面上反复出现的东西用 `src/ui/` 里的共用类或组件，不在功能样式表里另写一份。

| 东西 | 类或组件 | 写在哪里 |
| --- | --- | --- |
| 按钮（普通、主要、危险） | `.k-btn`、`.k-btn.is-primary`、`.k-btn.is-danger` | `src/ui/ui.css` |
| 低强调按钮 | `.k-btn.is-quiet`（按钮行里的无底按钮，补救没做成的事加 `.is-warn` 警示语气）、`.k-link`（文字里的操作链接） | `src/ui/ui.css` |
| 复选框 | `.k-check` | `src/ui/ui.css` |
| 图标按钮 | `.k-icon-btn` | `src/ui/ui.css` |
| 控件里的单行文字 | `.k-label` | `src/ui/ui.css` |
| 输入框 | `.k-input` | `src/ui/fields.css` |
| 下拉、可搜索下拉 | `Select`、`Combobox`（`.k-select`、`.k-combo`） | `src/ui/` |
| 浮层外壳 | `.k-positioner`、`.k-popup` | `src/ui/ui.css` |
| 菜单 | `Menu`（`src/ui/menu/`） | `src/ui/menu.css` |
| 分段控件 | `Segmented`（`.k-seg`） | `src/ui/` |
| 开关 | `Switch`（`.k-switch`） | `src/ui/` |
| 悬停提示 | `Tip`（`.k-tip`）与 Dock（`.k-dock-tip`）共用纸面、墨字、6 / 10 内边距 | `src/ui/ui-dock.css` |
| 轻提示 | `Toast`（`.k-toast`） | `src/ui/toast.css` |
| 对话框 | `.k-dialog`、`DialogHeight` | `src/ui/ui-dock.css` |
| 设置行 | `SettingsList`（`.k-set-row`） | `src/settings/settings.css` |
| 胶囊 | `.k-pill`（`.is-ok`、`.is-warn`、`.is-accent`、`.is-mine`） | `src/ui/ui-dock.css` |
| 按键名 | `.k-keys`、`.k-key` | `src/ui/ui-dock.css` |
| 侧栏行 | `.k-row`（30 高，图标、名字、张数；选中是指示条） | `src/ui/row.css` |
| Dock | `Dock`（`.k-dock`） | `src/ui/ui-dock.css` |
| 计数角标 | `.k-badge`（图标按钮右上角的墨色数字，图标轨与 Dock 共用） | `src/ui/ui-dock.css` |
| 16 px 标题 | `.k-title`（页面、侧栏、对话框、设置页的标题；外边距与对齐由所在区域另写） | `src/ui/ui.css` |
| 12 px 分组名 | `.k-section-label`（菜单、字段、浮层里的分组名；菜单里加 `.is-menu` 与选项文字对齐） | `src/ui/ui.css` |
| 说明文字 | `.k-description`（12 / 18，次要墨色；段前间距加 `.is-spaced`；正文档加 `.is-body`，13 px、行高继承） | `src/ui/ui.css` |
| 报错文字 | `.k-error-text`（12 px，危险色，行高继承；底框加 `.is-boxed`，字段图标行加 `.is-field`） | `src/ui/ui.css` |
| 空状态 | `EmptyState`（`.k-empty.is-page` 整页、`.k-empty.is-list` 列表内；标题必填，说明与操作可选） | `src/ui/EmptyState.tsx`、`src/ui/empty-state.css` |
| 标签块与块内操作 | `.k-token`（24 / 26 / 28 px、圆角与底色修饰类）、`.k-token-action`（16 / 18 / 20 px） | `src/ui/token.css` |
| 转圈 | `.k-spinner`（颜色继承，强调色加 `.is-accent`；尺寸沿用图标） | `src/ui/spinner.css` |

详情面板一级标签使用 `.is-inspector.is-primary-tag`：最小 28 px、横向内边距 10 px、纵向 4 px、13 px 字与 20 px 名称行高；一般标签最小 26 px、内边距 `4px 8px`、12 px 字与 18 px 名称行高。一级修饰类的优先级高于一般档，避免一般规则覆盖。

### 例外

- 订阅对话框（`src/subscriptions/subscriptions.css`）里从关注导入的复选名单与画师行没有用共用类：只有这两处用，等第三处出现再收。

## 样式写在哪里

- **令牌**只写在 `src/styles/tokens.css`，其他样式表只写 `var(--token)`。
- **共用类**写在 `src/ui/` 的样式表里。
- **样式表跟着部件走。** 一个部件的规则写在一份样式表里，和它的组件放在同一个文件夹（如 `src/wall/wall.css`、`src/shell/sidebar.css`、`src/settings/settings.css`），只管那一块。`src/styles/` 只放 `tokens.css` 与 `base.css`。
- 一个类的基础规则只写在一份样式表里，不在另一份里写同名规则去覆盖它。`src/styles/single-base-rule.styles.test.ts` 会挡住。
- 一份样式表保持在 20 KB 以内；超了按职责拆，文件名说明它管什么。
- `src/styles.css` 是唯一样式入口，先声明 `@layer tokens, base, ui, layout, feature;`，再用带 `layer(...)` 的 `@import` 导入全部样式表。生产 TS 只导入 `src/styles.css`，不绕过入口导入部件样式。
- 层优先级高于选择器特异性：普通规则按 `tokens` < `base` < `ui` < `layout` < `feature` 取胜，同一层内仍按导入次序。挪动层、次序或把规则搬到别的文件前，先确认没有靠层或次序取胜的规则。
- 归层口径：`tokens` 放令牌，`base` 放元素基础样式，`ui` 放共用件、共用类与必须留在共用件之下的低层旧规则，`layout` 放窗口框架、顶栏与侧栏骨架，`feature` 放功能界面和它对共用件的定制。`feature` 里的共用件定制必须像类名一样标明区域，不回收成共用类。现在的低层旧规则是 `src/search/search.css`（顶栏查找框底子）、`src/library/tag-panel.css`（标签行与别名编辑器的底子）和 `src/shell/sidebar-base.css`（`.k-row` 之下的侧栏行底子）。
- 已知要保住的次序：
  - `src/settings/settings.css` 早于 `src/ui/dialogs.css`：后者减弱动效的规则要盖过设置页签的过渡。
  - 叠成一摞的图集（`src/wall/wall.css` 后半）排在卡片规则与 `src/wall/wall-floats.css` 之后。
  - `src/shell/sidebar-base.css` 早于 `src/ui/row.css`，`src/shell/sidebar.css` 排在 `src/shell/frame.css`、`topbar.css` 之后：侧栏的行也带 `.k-row`，前者要让 `.k-row` 盖过，后者要盖过共用类。
- `:focus-visible` 的全局默认在 `ui` 层；`feature` 层的局部焦点例外能按层覆盖它，例外仍只准写令牌、`0` 或 `none`，`src/styles/focus.styles.test.ts` 会挡住。
- 新规则写进组件旁边的样式表，不往 `src/styles/` 里加；新样式表同时写进 `src/styles.css` 与 `src/styles/layers.styles.test.ts` 的归层表。

### 挡住回退的测试

下面这些样式测试扫描全部样式表，发现档位以外的写法就失败；确有理由的例外列进 `ALLOWED` 并写理由。

- `src/styles/tokens.styles.test.ts`：令牌文件以外的十六进制颜色
- `src/styles/focus.styles.test.ts`：焦点环以外的焦点写法
- `src/ui/popup.styles.test.ts`：浮层外形
- `src/styles/motion.styles.test.ts`：令牌文件以外的 `transition`、`animation` 里写死的时长
- `src/styles/scales.styles.test.ts`：10 以上的 `z-index` 数字、不可用规则里写死的透明度、写死的 `backdrop-filter`
- `src/ui/headings.styles.test.ts`：`.k-title`、`.k-section-label` 以外另写的标题、分组名字形，以及收掉的旧类名
- `src/ui/note-error.styles.test.ts`：`.k-description`、`.k-error-text` 以外另写的说明、报错字形，以及收掉的旧类名
- `src/ui/low-emphasis-buttons.styles.test.ts`：扫描全部 CSS、TS、TSX，挡住低强调按钮旧类名的用处和样式定义
- `src/ui/empty-state.styles.test.ts`：扫描生产 CSS、TS、TSX，挡住空状态旧类名；锁住两档共用样式与可搜索下拉的行布局
- `src/ui/token.styles.test.ts`：挡住标签块旧类名与区域字形、颜色、尺寸覆盖；锁住共用档位、一级标签 28 px 与可信度三档
- `src/styles/layers.styles.test.ts`：层声明顺序、每份样式表的归层，以及生产 TS 绕过入口直接导入部件样式
- `src/styles/single-base-rule.styles.test.ts`：一个类的基础规则写在两份样式表里；`src/styles.css` 不先导入 `tokens.css`
