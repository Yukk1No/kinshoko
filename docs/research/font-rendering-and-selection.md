# Kinshoko 字体渲染与字体选型调研

调研日期：2026-10-05。

研究前提：Windows 是首个验收场景；当前候选技术路线是 Tauri 2 / Rust + React / TypeScript / Vite，界面文本在 WebView2 中排版。中文 UI 会混排中日英标签、画师名和作品名。现有自绘 wordmark 继续使用。本文区分「官方事实」「资源观察」和「设计建议」；字号、观感、启动耗时与内存尚未在正式应用中验收。

**2026-10-05 用户已确认本报告的默认字体组合：Inter 4.1 静态 hinted 400/500/600 + 完整 Source Han Sans SC VF 2.005R。** 以当前 WebView2 路线使用本地 WOFF2 和 DOM 排版作为接入基线；实际低 DPI 清晰度、资源加载和混合 DPI 验收仍保留。该选择承接 [#13 的字体设计要求](https://github.com/Yukk1No/kinshoko/issues/13)，作为 [#9 技术路线决策](https://github.com/Yukk1No/kinshoko/issues/9) 的输入；不代表整个正式技术路线已经通过验收。

## 渲染方案：复用 WebView2 的 DOM 文字链路

### 项目选型与证据范围

本次以 **Tauri 2 + Rust、React/TypeScript/Vite 静态前端、Windows WebView2** 为前提。当前主检出仍是领域文档与 tagger probe，没有正式 UI 应用；依据来自既有方案分支的 [PRODUCT.md](https://github.com/Yukk1No/kinshoko/blob/dd2ec043999e54de90f63563bcaea6f5ece56273/PRODUCT.md)、[首个功能实现提案](https://github.com/Yukk1No/kinshoko/blob/dd2ec043999e54de90f63563bcaea6f5ece56273/docs/discovery/first-production-feature-plan.md) 和 [桌面钉图原型](https://github.com/Yukk1No/kinshoko/blob/3c3c61bd435b6614ad861fc71c6a2223a73b61e5/prototype/desktop-pin/README.md)。这些是当前路线与原型事实，不将候选组合改写成已通过正式技术路线验收。

**建议采用浏览器 DOM 文字 + 本地 WOFF2 + 标准 CSS 排版；不增加独立字体渲染引擎。** Tauri 官方确认 Windows 使用 Edge/Chromium 的 WebView2，macOS/Linux 使用 WebKit，因此 React 和 Rust 并不直接决定字形栅格化，也不能由 Windows 结果推定其他平台外观相同。[Tauri WebView 说明](https://v2.tauri.app/reference/webview-versions/)

### 能控制什么

Microsoft 对 Chromium 文字链路的说明区分了 DirectWrite 的字体/字形工作和 Skia 的最终合成。当前 Chromium Windows 字体管理源码仍有 DirectWrite 路径，另有 Fontations 后端的稳定化记录。对应用而言，应把它当作由实际 Runtime 管理的浏览器文字系统；不要把每一种 web font 都描述成直接调用原生 DirectWrite，也不承诺与 WinUI 的像素结果完全一致。[Edge 官方说明（2021，架构背景）](https://blogs.windows.com/msedgedev/2021/06/02/improving-font-rendering-in-microsoft-edge/)、[Chromium 字体管理源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/skia/ext/font_utils.cc)、[Fontations 稳定化提交](https://chromium.googlesource.com/chromium/src/+/1c4f2cd372afa3880a680a7926684bd9b1d81870%5E%21/)

应用直接负责字体文件/字重、字号/行高、文字颜色、语言标注、布局/动效和字体加载。以下比较是据官方能力提出的工程建议，不是渲染性能榜：

| 路线 | 接入当前技术栈的方式 | 判断 |
| --- | --- | --- |
| WebView2 DOM + 本地字体 | 保留 HTML 控件与文字，使用 `@font-face` | **默认推荐**；使用已有文字、输入和布局系统，离线可加载固定资源 |
| WebView2 DOM + 系统字体 | 沿用 Segoe UI / Microsoft YaHei UI 回退栈 | 安装资源最省；作为备用显示模式和对照，允许设备间字形/指标差异 |
| CanvasKit / 自绘 Skia 文字 | 通过 WebAssembly 在画布绘制，另行接回文字输入与可访问语义 | 当前 UI 不引入；它提供的是绘制能力，不会替换 DOM 的字体渲染 |
| WebView2 对比度 flags | 开发环境诊断 `msEnhancedTextContrast` 等 | 只用于定位问题；Microsoft 明确不建议生产依赖这些可变 flags |

CanvasKit 是 Skia 的 WebAssembly 接口；Canvas 内容需要额外提供可访问的 DOM/回退语义。因而若为“中文字稍细”把搜索框、标签、导航都改成自绘，输入、选择、可访问性和同步布局会成为新的应用工作。这是接入成本的判断，尚未做性能实验。[Skia CanvasKit](https://skia.org/docs/user/modules/canvaskit/)、[Mozilla Canvas 可访问性说明](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Basic_usage)、[WebView2 flags 官方限制](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags)

### 对清晰度最有用的落实点

1. **核心 UI 用 13–14 CSS px 起步，关键操作/输入用 14 px，说明文字尽量不低于 12 px。** 这些是初始设计值，须在画师的实际屏幕确认。既有参考工作区样稿的正文是 13 px，但图片说明和钉图页脚有 10–11 px；优先检查这些读起来吃力的文本，而不是先换渲染器。[既有样稿 CSS](https://github.com/Yukk1No/kinshoko/blob/dd2ec043999e54de90f63563bcaea6f5ece56273/prototype/reference-workspace/src/styles.css)
2. **使用真实字重，保留 `font-synthesis: none`。** 它禁止假粗体/假斜体，不禁止字体自身的可变轴；实际要使用的 400/500/600 必须有对应 face 或变量覆盖。[CSS Fonts：font-synthesis](https://drafts.csswg.org/css-fonts-4/#font-synthesis)
3. **文字表面优先有稳定底色，停止动效后恢复普通布局。** Chromium 当前测试对不透明内容/背景、非整数平移、`will-change: transform`、变换动画等分别判定 LCD 文字可用性；其中单独 `opacity: .5` 甚至被允许。因此不能写成“所有透明/transform 都会糊”，也不能用 `translateZ(0)` 当通用清晰度优化。[Chromium LCD 文字测试](https://chromium.googlesource.com/chromium/src/+/HEAD/cc/layers/picture_layer_impl_unittest.cc)
4. **图库缩放只作用于图片观察层。** 搜索、标签和窗口控制保持自己的 CSS 布局/字号；避免将整套界面反复作为位图放大。高 DPI 使用实际 Runtime 的逻辑像素与缩放，不为文字另乘一次 `devicePixelRatio`。这属于实施建议，混合 DPI 仍须 Tauri 实包验证。
5. **先用标准排版属性。** `text-rendering: auto` 是起点；`optimizeLegibility` 主要提示字距/连字等取舍，不是“打开抗锯齿”。`-webkit-font-smoothing` / `-moz-osx-font-smoothing` 的相关实现只在 macOS 生效，不能用它们修复 Windows WebView2。[Mozilla text-rendering](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/text-rendering)、[Mozilla font-smooth](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-smooth)

### 本地资源与首次显示

字体放在前端构建资源中，以应用资源 URL 加载；**产品不依赖 Google Fonts CDN，也不要求用户先安装字体**。为预期同一版本的外观，打包 face 不先写 `local(...)` 匹配未知系统版本。Tauri CSP 的 `font-src` 要允许实际应用源，保持与已有策略合并；不要照抄官方展示远端字体的示例。[Tauri CSP](https://v2.tauri.app/security/csp/)

默认 `font-display: swap` 让文字先有系统回退，再换入字体；它可能改变文字宽度。只预加载确实首屏使用的关键资源；CJK 全量资源是否预加载、是否分片应按冷启动数据决定，先不把分片作为前置复杂度。[font-display 的标准行为](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@font-face/font-display)

瀑布流/虚拟列表若测量了包含标题、标签的行高，在字体加载后应重新测量并维持原图片身份的滚动锚点。可以用 `document.fonts` 的加载事件和 `ready` 驱动，不需要仅为这件事引入第三方 webfont loader；失败时保持系统回退，不能让整个 UI 无限等待字体。[CSS Font Loading API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Font_Loading_API)

`document.fonts.ready`/face 的 `loaded` 只证明相关字体加载与布局完成，不证明每个字符都来自指定字体。地区字形、缺字、emoji 仍需渲染核验。

## 已确认字体选择

**已确认默认组合：Inter 4.1 静态 hinted WOFF2（400 / 500 / 600）+ 完整的 Source Han Sans SC VF（思源黑体，2.005R，TTF 轮廓的 WOFF2）。** 三个 Inter 文件承担西文与数字，单个完整 SC 文件承担中日韩文字；中文界面设 `lang="zh-CN"`，已知日文内容设 `lang="ja"`。品牌气质由现有色彩和 wordmark 表达，工具界面的文本先保证易读。

选择理由是字体资源可固定版本、随应用离线分发，且思源黑体已经提供完整的官方 WOFF2。Inter 的官方说明确认：静态 TTF 和 `extras/woff-hinted` 有 TrueType hints，变量版和默认 web 版没有相同的 hints。因此以 hinted 静态版作为 Windows 100% 缩放下的默认，并保留变量版实包比较；**有 hints 不等于在所有 WebView2、屏幕和背景上一定更清晰**。[Inter 4.1 发行说明](https://github.com/rsms/inter/blob/v4.1/misc/dist/help.txt)、[Source Han Sans 2.005R 官方发布](https://github.com/adobe-fonts/source-han-sans/releases/tag/2.005R)。

可撤回替代：如果实测变量 Inter 的小字号观感相当，可换为一个 `InterVariable.woff2`，减少文件数并使用光学字号轴；如果需要优先减小安装包，可先使用 Windows 系统字体栈，把完整思源黑体作为可选或后续资源。字体家族应通过集中定义的 CSS token 选择，避免把这些方案写进每个组件。

## 候选字体比较

| 候选 | 官方事实与资源观察 | 对 Kinshoko 的判断（设计建议） |
| --- | --- | --- |
| **Inter** | 官方定位包含细密 UI；具有较高的 x-height、光学字号、等宽数字等特性，常规到半粗对应 400 / 500 / 600。发行包提供静态、变量与 web 文件。[官方网站](https://rsms.me/inter/)、[4.1 README](https://github.com/rsms/inter/blob/v4.1/README.md) | 用于西文和数字；CJK 由另一家族负责。先验收静态 hinted，变量版作为等价候选。12 px 以下不作为工具主文本的设计目标。 |
| **Source Han Sans SC VF / 思源黑体** | Adobe 与 Google 合作的 Pan-CJK 项目；Google 以 Noto Sans CJK 发布同源设计，但两个项目当前发布版本并不完全同步。Adobe 当前 2.005R 提供变量 OTF / TTF / WOFF2。[Adobe 项目背景](https://blog.adobe.com/en/publish/2021/04/08/source-han-sans-goes-variable)、[2.005R 发布](https://github.com/adobe-fonts/source-han-sans/releases/tag/2.005R) | 中文主字体首选。选完整 SC 单文件，避免一开始为 JP 再打包一份相近的完整字体。 |
| **Noto Sans CJK SC / JP** | 官方区分 language-specific 完整字体和 region-specific 子集；完整字体可用语言标注与 OpenType `locl` 切换地区字形。`Noto Sans CJK SC` 与 `Noto Sans SC` 不是同一部署配置。[Noto Sans CJK 下载指南](https://github.com/notofonts/noto-cjk/blob/main/Sans/README.md) | 是思源黑体的合理替代；不能把 Google Fonts 中的 `Noto Sans SC` 名称当作完整 Pan-CJK 的保证。本次优先 Adobe 提供的原始 WOFF2，减少自行转换步骤。 |
| **Segoe UI Variable + Microsoft YaHei UI** | 微软将 Segoe UI Variable 用于西文、希腊文、西里尔文；推荐 YaHei UI 用于简体中文、Yu Gothic UI 用于日文、JhengHei UI 用于繁体中文。YaHei UI 只有 Light / Regular / Bold 等静态字重。[Windows 字体建议](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography)、[YaHei 家族](https://learn.microsoft.com/en-us/typography/font-list/microsoft-yahei) | Windows 原生观感与零新增字体下载的基线。系统版本、字体可用性和跨平台外观更难固定；适合作为小包方案与回退。 |
| **LXGW WenKai / 霞鹜文楷** | 作者说明其基于 Klee One，含简繁、日韩文字，三个静态字重，主要以 TTF 发布；同时提示部分补字和字重存在轮廓瑕疵，日文用户建议直接使用 Klee One。[官方说明](https://github.com/lxgw/LxgwWenKai/blob/main/README.md) | 若以后需要文艺气质，可试用在 20 px 以上的短标题、欢迎页或少量注释。不给密集标签、文件名、按钮和设置项使用，也不将中文文楷当作日文地区字形方案。 |
| **Source Han Serif SC / 思源宋体** | 是 Pan-CJK 宋体项目，提供静态和变量 OTF / TTF / WOFF2；当前官方版本为 2.003R。[项目](https://github.com/adobe-fonts/source-han-serif)、[2.003R 发布](https://github.com/adobe-fonts/source-han-serif/releases/tag/2.003R) | 书库主题的大标题备选，比正文再增加一种全量字体的收益有限。初版 UI 不加入；若采用，仅用于较大的短标题。 |

## 名称、覆盖范围与中日地区字形

**官方事实：**完整 `SourceHanSansSC-VF` 以简体中文为默认，包含五个地区的字形；其他地区通过 `locl` 和语言标注访问。完整资源有 65,535 个 glyph，并包含地区子集列出的标准；glyph 数量不是 Unicode 码点数量，更不表示覆盖全部 Unicode。[Source Han Sans 2.005 ReadMe，第 3、9 页](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/SourceHanSansReadMe.pdf)。

对应名称须分清：

- 完整 SC 变量文件：`SourceHanSansSC-VF.ttf.woff2`，官方家族名为 `Source Han Sans SC VF`；完整日文默认变量文件是 `SourceHanSans-VF`，无 `JP` 后缀。[官方变量名称定义](https://github.com/adobe-fonts/source-han-sans/blob/master/FontMenuNameDB.VF)。
- Adobe 的简体地区子集使用 `SourceHanSansCN-VF`；日文子集使用 `SourceHanSansJP-VF`。它们与完整 SC 的字汇不同。[官方子集名称定义](https://github.com/adobe-fonts/source-han-sans/blob/master/FontMenuNameDB.VF.SUBSET)。
- Noto 对应完整家族叫 `Noto Sans CJK SC` / `Noto Sans CJK JP`；地区子集叫 `Noto Sans SC` / `Noto Sans JP`。[Noto 下载指南](https://github.com/notofonts/noto-cjk/blob/main/Sans/README.md)。

**建议与推断：**先用一个完整 SC 文件，依靠语言标注切换已知日文；在浏览器中验收 `骨、直、令、返` 等同码点地区字形以及假名。繁体内容有可靠地区信息时分别使用 `zh-TW`、`zh-HK`；仅知道繁体时可用 `zh-Hant`，但不能从这个标签推出台湾或香港来源。语言未知的共享汉字使用界面默认，不做强行推断。CSS 规范规定字形选择应参考内容语言，语言标签与开启 `locl` 是不同的输入：仅写 `"locl" 1` 不能告诉字体要哪个地区。[CSS Fonts 3，Language-specific display](https://www.w3.org/TR/css-fonts-3/#language-specific-support)。

只有在文本消费者不能传语言信息、不支持 `locl`，或者未来制作日本地区专用小包时，才需要改用明确的 JP 字体资源。完整字体支持其他地区的官方说明不能替代具体 WebView2 版本的实测。

系统字体对照可使用 `"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif`；日文对照元素的 CJK 项换成 `"Yu Gothic UI"`。Windows 11 清单列出 Segoe UI Variable 的 Text / Small / Display 命名实例，浏览器是否命中预期家族仍须检查实际 rendered fonts，不能只看 CSS computed family。[Windows 11 字体清单](https://learn.microsoft.com/en-us/typography/fonts/windows_11_font_list)。

## 文件格式与体积

静态 TTF / OTF、变量 TTF / OTF 和 WOFF2 分别涉及字重、轮廓格式与交付容器，不能混为一谈：

- **静态字体**适合明确只用少数字重的方案；Inter 400 / 500 / 600 的 hinted WOFF2 可以直接使用官方文件。不能仅从扩展名 `.ttf` 推出该文件具有 hinting。[Inter 4.1 说明](https://github.com/rsms/inter/blob/v4.1/misc/dist/help.txt)。
- **变量字体**把多字重放进一个文件。Source Han Sans SC 的源码权重轴为 250–900，400 是 Regular、500 是 Medium、700 是 Bold；600 可插值。CSS `@font-face` 应声明实际范围并明确主文本为 400，避免把字体的默认 250 误用作 UI 正文。[Source Han SC 设计空间](https://github.com/adobe-fonts/source-han-sans/blob/master/Masters/designspaces/SourceHanSansSC-VF.designspace)。
- **本次 CJK 选 TTF 轮廓的 WOFF2。**Adobe 的历史发布说明记录过旧版 Windows 对变量 OTF 的 CFF2 问题及修复版本；这不能证明同一问题必然出现在 WebView2，实际最低系统与运行时仍需验收。[Source Han Sans 2.004R 的兼容性说明](https://github.com/adobe-fonts/source-han-sans/releases/tag/2.004R)。
- **WOFF2 是本路线的交付格式。**若以后更换为非 Web UI，必须重新核实那个渲染器支持的字体容器、变量轴与 shaping；不能把 WebView2 可加载 WOFF2 推广为任意 Rust 原生渲染库都能使用它。

以下为 2026-10-05 对官方发布包或 GitHub 元数据的**资源观察**，不是加载内存、解压时间或帧率基准。MiB = 1,048,576 字节。

| 资源 | 文件字节数 | 约 MiB | 精确来源 |
| --- | ---: | ---: | --- |
| Inter 4.1 hinted 400 + 500 + 600，共三个文件 | 429,236 | 0.409 | [官方 ZIP](https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip)，`extras/woff-hinted/Inter-{Regular,Medium,SemiBold}.woff2`；分别 140,944 / 143,664 / 144,628 字节 |
| Inter 4.1 variable，正体 | 352,240 | 0.336 | 同一 ZIP 的 `web/InterVariable.woff2`；[官方仓库文件](https://github.com/rsms/inter/blob/v4.1/docs/font-files/InterVariable.woff2) |
| 思源黑体完整 SC，TTF 轮廓变量 WOFF2 | 14,129,688 | 13.475 | [2.005R 原始文件](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/Variable/WOFF2/TTF/SourceHanSansSC-VF.ttf.woff2) |
| 思源黑体地区 CN 子集，TTF 轮廓变量 WOFF2 | 7,711,988 | 7.355 | [2.005R 官方子集](https://github.com/adobe-fonts/source-han-sans/blob/2.005R/Variable/WOFF2/TTF/Subset/SourceHanSansCN-VF.ttf.woff2) |
| Noto Sans CJK SC 完整变量 TTF | 36,144,788 | 34.470 | [官方完整 SC TTF](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Variable/TTF/NotoSansCJKsc-VF.ttf) |
| Noto Sans SC 地区子集变量 TTF | 17,773,132 | 16.950 | [官方地区 SC TTF](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf) |
| Noto Sans CJK SC 完整静态 Regular OTF | 16,437,364 | 15.676 | [官方 Regular OTF](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf) |
| 霞鹜文楷 1.522 Regular TTF | 25,575,676 | 24.391 | [官方 1.522 发布资产](https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522) |
| 思源宋体完整 SC，TTF 轮廓变量 WOFF2 | 21,600,852 | 20.600 | [2.003R 官方文件](https://github.com/adobe-fonts/source-han-serif/blob/2.003R/Variable/WOFF2/TTF/SourceHanSerifSC-VF.ttf.woff2) |

Noto 上述快照的 `Sans` 目录未提供 WOFF2，不能将 `android/NotoSansCJK-wght-400-900.ttf.woff2` 当作同一完整 SC 资源。这个结论来自当前文件树，而非所有 Noto 分发渠道。[本次查询的官方文件树](https://api.github.com/repos/notofonts/noto-cjk/git/trees/f8d157532fbfaeda587e826d4cd5b21a49186f7c?recursive=1)。

**建议：**第一轮把约 14.6 MB 的完整默认组合随应用打包，先测离线首次显示、动态内容覆盖与小字号。CJK 分片优化应有性能数据后再做；即使利用 `unicode-range` 按需读取，离线安装包仍需包括完整的分片集合，分片不会自动减小总包体。Google Fonts 的 `text=` 优化面向已知文本；它不适合作为任意用户画师名、作品名和标签的唯一字汇来源。[CSS Fonts 3，unicode-range](https://www.w3.org/TR/css-fonts-3/#unicode-range-desc)、[Google Fonts 的固定文本优化](https://developers.google.com/fonts/docs/css2#optimizing_your_font_requests)。

## 许可证与再分发

Inter、Noto CJK、思源黑体、思源宋体和霞鹜文楷均使用 SIL Open Font License 1.1。可以与应用一起分发，字体保持 OFL，随字体保留版权及许可证；软件本身不会因为聚合这些字体而必须改用 OFL。不得把字体文件单独售卖。[Inter 4.1 许可证](https://github.com/rsms/inter/blob/v4.1/LICENSE.txt)、[Noto Sans 许可证](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE)、[思源黑体 2.005R 许可证](https://github.com/adobe-fonts/source-han-sans/blob/2.005R/LICENSE.txt)、[思源宋体许可证](https://github.com/adobe-fonts/source-han-serif/blob/master/LICENSE.txt)、[文楷许可证](https://github.com/lxgw/LxgwWenKai/blob/main/OFL.txt)、[OFL FAQ 1.3 / 1.20](https://openfontlicense.org/ofl-faq/)。

原始官方文件直接使用最简单。后续自己裁字、删 GSUB 特性、合并字体或修改轮廓时，须按衍生字体处理，保留许可并检查 Reserved Font Name。Adobe 保留 `Source`；Inter README 声明 `Inter`，尽管 4.1 随包许可证的版权首部未单列这个名字，不应据此推断可以沿用原名发布改版。单纯无损 WOFF / WOFF2 压缩、原始字体数据及对应元数据保持不变，有 OFL FAQ 规定的例外；裁字通常不属于这种情况。[Source 的保留名称](https://github.com/adobe-fonts/source-han-sans/blob/2.005R/LICENSE.txt)、[Inter 的名称声明](https://github.com/rsms/inter/blob/v4.1/README.md#creating-derivative-fonts)、[OFL FAQ 2.2–2.8](https://openfontlicense.org/ofl-faq/)。

霞鹜文楷保留 `霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW`，当前许可另列了特定 web font 裁字或格式转换的额外授权。不要把它推断为所有桌面应用分发、所有平台均无条件获准保留名字；如果后续采用，直接使用原始文件，或者给修改版本另取名字。本次没有下载文楷，也没有利用这条例外。[文楷 OFL 的额外授权](https://github.com/lxgw/LxgwWenKai/blob/main/OFL.txt)。

Windows 系统字体方案只引用用户系统中已存在的字体。普通 Windows 授权不允许把其字体复制进安装包、转成 WOFF2 或改造后分发；Segoe UI Variable 也不能据该系统授权分发到非 Windows 平台。[微软再分发 FAQ](https://learn.microsoft.com/en-us/typography/fonts/font-faq)。

## 接入示例

以下是供正式前端采用的最小方案；路径是前端构建资源示例，当前主检出没有这些应用资源。资源来源、命名和版本见上文，先使用原始文件，不自行改字体。

```css
@font-face {
  font-family: "Kinshoko Inter";
  src: url("/fonts/Inter-Regular-hinted.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Kinshoko Inter";
  src: url("/fonts/Inter-Medium-hinted.woff2") format("woff2");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Kinshoko Inter";
  src: url("/fonts/Inter-SemiBold-hinted.woff2") format("woff2");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Kinshoko Han";
  src: url("/fonts/SourceHanSansSC-VF.ttf.woff2") format("woff2");
  font-weight: 250 900;
  font-style: normal;
  font-display: swap;
}
:root {
  --font-ui: "Kinshoko Inter", "Kinshoko Han",
    "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
    "Segoe UI Emoji", system-ui, sans-serif;
  font-family: var(--font-ui);
  font-synthesis: none;
  text-rendering: auto;
}
body { font-size: 14px; line-height: 1.5; }
button, input, textarea, select { font: inherit; }
.ui-label { font-weight: 500; }
.ui-heading { font-weight: 600; }
.numeric { font-variant-numeric: tabular-nums; }
```

```html
<html lang="zh-CN">
<!-- 共享汉字的地区字形交给内容语言；不要只设置 locl 开关。 -->
<span lang="ja">作品：葬送のフリーレン</span>
<span lang="zh-TW">標籤與資料庫</span>
```

原生菜单、文件选择器等由 Windows 绘制的 UI 沿用系统字体；这组 CSS 作用于 WebView 内容。图片观察层可以有自己的缩放，工具文字按固定的 CSS 排版处理。

## 排版起点与字体验收

以下均为**设计建议，未经正式应用实测**；单位是 CSS px。

| 文本角色 | 字号 / 行高 | 字重 |
| --- | --- | --- |
| 按钮、导航、文件名、主要标签 | 14 / 20–22 | 400，激活或关键动作 500 |
| 可选密集标签 | 13 / 20 | 400–500；先与 14 px 验收可读性 |
| 次要计数、时间、尺寸等 | 12 / 18 | 400；核心信息不靠降低字号区分 |
| 面板标题 | 16 / 24 | 600 |
| 页面或资料库标题 | 20 / 28 | 600 |
| 多行备注、说明 | 14–15 / 22–24 | 400 |

正文先保持 `letter-spacing: 0`，不全局缩窄中文；避免用 250 / 300 的细字重承载小字号。数字列可单独开启 Inter 的 tabular numbers。Inter 的英文视觉大小、思源黑体的汉字视觉大小与共同 baseline 是否协调，应在混排行中判断，不能机械给所有中文做比例缩放。[Inter 的数字与视觉特性](https://rsms.me/inter/)。

建议保留下面的文本用于验收，不把它误用作全应用裁字清单：

```text
资料库 / 文件夹 / 智能文件夹 / 标签命名空间 / 参考组 / 桌面钉图
画师：髙橋さくら / 𠮷野 / 渡辺 / Sakimichan
作品：葬送のフリーレン — Frieren: Beyond Journey’s End
标签：长发、蓝发、齐刘海 / ショートヘア / blue_hair / artist:米山舞
语言样本：骨 直 令 返 曜；图 / 圖 / 図；「かな・カナ」与“中文标点”
数字与符号：Il1 O0 0123456789 1,024 00:09 1920×1080 125% 1/2 ±0.25
组合字符与 emoji：Café / Café / Zoë / 🎨 👩🏽‍🎨 📁
较新扩展区回退探针：𰻞；长文件名：参考图_2026-10-05_作品名与画师名.png
```

最低验收内容：

1. Windows 100% / 125% / 150% / 200% 缩放，至少包含一台低 DPI 屏幕；固定应用窗口字号，比较 Inter hinted、Inter variable 和系统栈的清晰度与中文均衡感。
2. `zh-CN` / `ja` / `zh-TW` / `zh-HK` 样本分别检查实际字形；`document.fonts.check()` 或字体加载成功不代表每个 glyph 都来自预期文件，需要查看实际 rendered fonts 和视觉结果。
3. 动态输入、删除、滚动、截断、多行备注、fallback 字体、emoji 与带声调组合字符不裁切，不因字体切换造成标签高度或行宽明显跳动。
4. 完全离线首次启动能显示所有固定 UI 文本；用户新输入的名字不会因「只裁了现有 UI 文案」变成方框。较新扩展汉字探针允许暴露覆盖边界，不能承诺任何一个 CJK 文件覆盖全 Unicode。
5. 在正式 Tauri 包中测冷启动到字体就绪的时间、首次出现新字汇的延迟、实际读取量与进程内存，记录 Windows / WebView2 / 字体版本。浏览器样张只是辅助，不能代替该验收。

## 本次比较用字体资源

已取回官方 Inter 4.1 ZIP 和思源黑体 2.005R 原始 WOFF2；五个比较字体文件与两个对应许可证放在当前聊天的可视化目录 `fonts/`，未安装到系统、未加入应用仓库。`font-manifest.json` 记录实际字节数、SHA-256、版本、原始 URL 和 Inter ZIP 内的入口。Inter 本地文件名加 `-hinted` 只是便于区分，没有修改字体数据。

已确认默认字体负载为三个 hinted Inter 文件与一个完整思源黑体 SC 文件，共 14,558,924 字节（约 14.6 MB / 13.9 MiB；不含许可证）。

本次已在 Codex 内置浏览器打开独立对照页，确认本地五个声明的字体 face 加载成功；三个对照组可切换浅深色和 400/500/600，并同步显示自定义标签。完整思源黑体 SC 在 `zh-CN` 与 `ja` 下的「骨、直」等地区字形差异可见。页面保留系统栈作为对照；它只能证明这次浏览器样张的表现，未完成正式 Tauri/WebView2 包、画师设备、物理 100% 缩放、启动性能或混合 DPI 验收。

未安装系统字体、修改应用代码或冻结新的 ADR；新增的仓库内容仅为这份调研报告。字体来源、许可与清晰度验收点已足够进入正式前端接入，性能优化按实包数据决定。
