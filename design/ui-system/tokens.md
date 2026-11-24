# 令牌与焦点环

## 令牌来源

`src/styles/tokens.css` 是界面令牌的唯一来源：颜色、封印书的 `--seal-acc`、圆角、控件高度、层级、动效时长都在 `:root` 里。档位见 [scales.md](scales.md)。

- 改颜色只改这一个文件。其他样式表只写 `var(--token)`，不写十六进制颜色。
- `src/styles/tokens.styles.test.ts` 扫描 `src/` 下所有样式表，在令牌文件之外发现十六进制颜色就失败。确有理由写死的，列进该测试的 `ALLOWED` 并写明理由。
- claude.ai 上的 Kinshoko 设计系统（`project/README.md`、`tokens.json`）从这个文件导出。改了令牌就把新值同步过去；两边不一致时以 `tokens.css` 为准。
- 查颜色只看 `tokens.css`，不必在各个组件样式表里搜。

### 日间与夜间

- 日夜两个值写在同一条声明里，先日间后夜间：`--ink: light-dark(#2b2747, #f4ecdc);`。
- 取哪个值由用到令牌的元素的 `color-scheme` 决定：`:root` 是 `light dark`（跟随系统），`data-theme="light"` 与 `data-theme="dark"` 各强制一种，`.k-dock.is-dark` 在日间也是 `dark`。
- 这几条规则只切 `color-scheme`，不重写令牌。新令牌照这个写法加，不另开夜间块。
- `light-dark()` 只装颜色，长度、透明度百分比放不进去。
- 阴影某一层的模糊半径日夜不同时，拆成两层，各写各的半径，颜色分别是 `light-dark(日间色, transparent)` 与 `light-dark(transparent, 夜间色)`（见 `--range-inset`）。一边多出的一层，另一边写 `transparent`。
- 要按透明度用的颜色令牌（如 `--contact`），在用处写 `color-mix(in srgb, var(--contact) 30%, transparent)`。
- `--seal-acc` 是品牌不变项，保留原型的三条规则，不改成 `light-dark()`。

## 强调、人工、警告

三种颜色各管一件事，不能互相借用。

| 令牌 | 意思 | 日间 | 夜间 |
| --- | --- | --- | --- |
| `--accent`、`--accent-soft` | 选中、焦点、指示条 | 樱 `#e0768f` | 金 `#e3b34f` |
| `--manual`、`--manual-soft`、`--manual-strong` | 画师亲手做的决定 | `#8a5e08`，胶囊字 `#5e4510` | 金 `#e3b34f`，胶囊字 `#f0cf86` |
| `--warn`、`--warn-strong`、`--warn-soft` | 要画师处理的问题 | 琥珀橙 `#a14f12`，胶囊字 `#7c3a0e` 配 `#fbeadb` | `#ec9a56`，胶囊字 `#f6b885` 配 `rgba(236, 154, 86, 0.14)` |

- 强调色用描边加浅底认出来，如 `.chip.pick.is-on`。
- 人工色只用在 `.k-pill.is-mine`：浅底配 `--manual-strong` 字。标签不用人工色，标签按可信度分三档（见 [components.md](components.md)“详情面板的标签”）。
- 警告在文字、胶囊和圆点处一律带警告图标（`WarnIcon`，lucide 三角，跟文字同色）。
- 琥珀橙和危险红（日 `#b23a3a`、夜 `#f08a8a`）色相只差约 26°，所以警告不能只靠颜色。
- `StatusPill tone="warn"` 默认带图标；其他地方在文字前放 `<WarnIcon />`。本身就是图标的地方（订阅行失败、打标“有图没有完成”的状态图标）不另加。
- `--warn` 在 `bg`、`surface`、`surface-2`、`sunken` 上的对比度：日间 4.68–5.67，夜间 6.22–7.79。胶囊字在各自浅底上都过 4.5:1。
- `src/styles/tokens.styles.test.ts` 检查这些对比度，并检查三种颜色互不相同。

## 焦点环

- 只有一种：`outline: var(--focus-ring)`，2 px 实线 `--accent`（日间樱色、夜间金色）。
- 只在键盘焦点时画（`:focus-visible`）。下拉获得焦点时同样画。
- 查找框、`.k-input`、备注框这些输入类控件获得焦点时不画焦点环，槽口换成 `--well-focus`（见 [main-window-material.md](main-window-material.md)“槽”）。
- 除此之外，不用 `box-shadow` 或 `--ink` 描边代替焦点环。
- 默认偏移 `outline-offset: var(--focus-offset)`（2 px，画在元素外面）。
- 贴边或外圈会被裁掉的地方用 `var(--focus-inset)`（-2 px，画在元素里面）：设置的竖排页签、分组卡片标题、图片大小旋钮、输入框与下拉（在会滚动的对话框里外圈会被裁掉）、详情面板的拖动条。
- 其余地方不自己写偏移数字。
- 对话框打开时的初始焦点不画环：设置的初始焦点落在对话框本身，不落在关闭按钮上；按 Tab 之后才出现环。
- `src/styles/focus.styles.test.ts` 扫描所有样式表，发现别的焦点写法就失败。
