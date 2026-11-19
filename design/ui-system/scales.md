# 档位、层级与共用类

这份文件写样式时取数值的地方：字号、圆角、控件高度、层级、不可用、半透明面板、动效各有哪几档，共用类有哪些，样式写在哪个文件里。颜色令牌见 [tokens-and-components.md](tokens-and-components.md)“令牌来源”。

数值的唯一来源是 `src/styles/tokens.css`。这里只写有哪几档、各用在哪里；两边对不上时以 `tokens.css` 为准，并在同一个 PR 里改这份文件。

#598 正在把档位以外的写法收进来。

## 字号

只有三档：16、13、12 px。

| 档 | 用在哪里 |
| --- | --- |
| 16 | 页面与对话框标题、侧栏标题 |
| 13 | 正文、控件文字、菜单行 |
| 12 | 分组名、说明、角标、快捷键提示 |

级联菜单的行（14 px）与组名 `.k-menu-title`（11 px）是现在仅有的例外，由 #601 收回三档。

## 圆角

都在 4 px 网格上，由外向内排：内圆角 = 外圆角 − 内边距，最小 4。

| 令牌 | 值 | 典型用处 |
| --- | --- | --- |
| `--r-xs` | 4 | 最内层的小块 |
| `--r-s` | 8 | 菜单项、分段项、开关 |
| `--r` | 12 | 输入框、按钮、面板 |
| `--r-l` | 16 | 浮层 |
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
| 窄窗口浮出侧栏的遮罩 | 29 | `--z-pane-scrim` | `.pane-scrim`（`src/shell/pane-fit.css`） |
| 窄窗口浮出的侧栏 | 30 | `--z-pane-float` | `.sidebar-slot[data-float]`（同上） |
| 界面特效层 | 38 | `--z-fx` | `.fx-layer`（`src/styles/shell.css`） |
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

一个值：透明度 0.5，令牌 `--disabled-opacity`。`:disabled`、`[data-disabled]`、`[aria-disabled]` 的规则都用它，不再按地方调深浅。

## 半透明浮动面板

一种配方：底色 `--glass-bg`（`--surface` 的 86%），模糊 `--glass-blur`（`blur(18px) saturate(1.2)`）。

用它的：dock、dock 托盘、图片大小浮岛、打标进度、轻提示、任务卡。钉图上的墨色提示条（`src/styles/desktop.css`）只用模糊，底色仍是墨色。级联菜单的模糊归“浮层”那一类，由 #601 定。

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
| `--t-progress` | 600 ms | 打标进度环的弧长变化（`src/shell/main-window-island.css`） |
| `--t-toast` | 400 ms | 轻提示叠放与展开时的位移（`src/ui/toast.css`） |
| `--t-splash` | 360 ms | 启动画面退场时标志与文字淡出（`src/shell/startup-splash.css`） |
| `--t-splash-hold` | 250 ms | 启动画面退场前标志多停的一会儿（同上） |

**脚本里的过渡**都从 `src/ui/motion.ts` 引用，不另写数值：

| 名称 | 档位 | 用在哪里 |
| --- | --- | --- |
| `arcSpring` | snappy 260 ms、morph 420 ms、smooth 400 ms | dock、悬浮栏、图片大小浮岛、对话框高度、查看器飞入 |
| `spring` | 原版 80 / 160 / 240 ms，只用 moderate | `FluidList` 的悬停高亮 |

**例外**

- 级联菜单的时间常量留在 `src/ui/menu/timing.ts`（淡入 170、位移 360 ms 与一条回弹曲线）。并不并入通用档位，等 #601 里维护者的回答。
- 封印与释放演出（`src/styles/library.css`）是品牌不变项，数值不动。
- 循环播放的动画（呼吸、转圈）有自己的周期。

## 共用类

界面上反复出现的东西用 `src/ui/` 里的共用类或组件，不在功能样式表里另写一份。

| 东西 | 类或组件 | 写在哪里 |
| --- | --- | --- |
| 按钮（普通、主要、危险） | `.k-btn`、`.k-btn.is-primary`、`.k-btn.is-danger` | `src/ui/ui.css` |
| 低强调按钮 | `.k-btn.is-quiet`（按钮行里的无底按钮，补救没做成的事加 `.is-warn` 警示语气）、`.k-link`（文字里的操作链接） | `src/ui/dialogs.css`，按钮基础在 `src/ui/ui.css` |
| 图标按钮 | `.k-icon-btn` | `src/ui/ui.css` |
| 控件里的单行文字 | `.k-label` | `src/ui/ui.css` |
| 输入框 | `.k-input` | `src/ui/fields.css` |
| 下拉、可搜索下拉 | `Select`、`Combobox`（`.k-select`、`.k-combo`） | `src/ui/` |
| 浮层外壳 | `.k-positioner`、`.k-popup` | `src/ui/ui.css` |
| 菜单 | `Menu`（`src/ui/menu/`） | `src/ui/menu.css` |
| 分段控件 | `Segmented`（`.k-seg`） | `src/ui/` |
| 开关 | `Switch`（`.k-switch`） | `src/ui/` |
| 悬停提示 | `Tip`（`.k-tip`） | 规则现在在 `src/shell/main-window.css`，#601 搬进 `src/ui/` |
| 轻提示 | `Toast`（`.k-toast`） | `src/ui/toast.css` |
| 对话框 | `.k-dialog`、`DialogHeight` | `src/ui/ui-dock.css` |
| 设置行 | `SettingsList`（`.k-set-row`） | `src/ui/settings.css` |
| 胶囊 | `.k-pill` | `src/ui/ui-dock.css` |
| Dock | `Dock`（`.k-dock`） | `src/ui/ui-dock.css` |
| 计数角标 | `.k-badge`（图标按钮右上角的墨色数字，图标轨与 Dock 共用） | `src/ui/ui-dock.css` |
| 16 px 标题 | `.k-title`（页面、侧栏、对话框、设置页的标题；外边距与对齐由所在区域另写） | `src/ui/ui.css` |
| 12 px 分组名 | `.k-section-label`（菜单、字段、浮层里的分组名；菜单里加 `.is-menu` 与选项文字对齐） | `src/ui/ui.css` |
| 说明文字 | `.k-description`（12 / 18，次要墨色；段前间距加 `.is-spaced`） | `src/ui/ui.css` |
| 报错文字 | `.k-error-text`（12 px，危险色，行高继承；底框加 `.is-boxed`，字段图标行加 `.is-field`） | `src/ui/ui.css` |

### 还没有共用类

下面这些同一种东西有几个类，#602 各收成一个，收完一类就移进上面的表、从这里删掉：

- 标签块：`.chip`、`.k-chip`、`.k-group-chip`、`.search-chip`、`.k-tag-chip`
- 空状态：`.subs-empty`、`.wall-empty`、`.app-empty-body`、`.capture-history-empty`、`.reference-groups-empty`、`.k-tags-empty`、`.k-groups-empty`、`.k-option-empty`
- 订阅页自带的行、标题、空状态、转圈（`src/subscriptions/subscriptions.css` 的 `subs-` 类）

## 样式写在哪里

- **令牌**只写在 `src/styles/tokens.css`，其他样式表只写 `var(--token)`。
- **共用类**写在 `src/ui/` 的样式表里。
- **一个区域或一个功能**的样式写在它组件旁边的样式表里（如 `src/shell/`、`src/search/`、`src/subscriptions/`），只管那一块。
- 一个选择器的基础规则只在一份样式表里。不要在另一份里写同名规则去覆盖它。
- 一份样式表保持在 20 KB 以内；超了按职责拆，文件名说明它管什么。
- `src/styles/` 下是原型留下的样式表，类名不带 `k-`。不往里加新规则；#603 把还生效的规则搬走，被覆盖的删掉。

### 挡住回退的测试

每收一类，加一条样式测试扫描全部样式表，发现档位以外的写法就失败；确有理由的例外列进 `ALLOWED` 并写理由。现有的：

- `src/styles/tokens.styles.test.ts`：令牌文件以外的十六进制颜色
- `src/styles/focus.styles.test.ts`：焦点环以外的焦点写法
- `src/ui/popup.styles.test.ts`：浮层外形
- `src/styles/motion.styles.test.ts`：令牌文件以外的 `transition`、`animation` 里写死的时长
- `src/styles/scales.styles.test.ts`：10 以上的 `z-index` 数字、不可用规则里写死的透明度、写死的 `backdrop-filter`
- `src/ui/headings.styles.test.ts`：`.k-title`、`.k-section-label` 以外另写的标题、分组名字形，以及收掉的旧类名
- `src/ui/note-error.styles.test.ts`：`.k-description`、`.k-error-text` 以外另写的说明、报错字形，以及收掉的旧类名
- `src/ui/low-emphasis-buttons.styles.test.ts`：扫描全部 CSS、TS、TSX，挡住低强调按钮旧类名的用处和样式定义
