# 原图查看器验证（#47）

2026-10-07。对应 [#47](https://github.com/Yukk1No/kinshoko/issues/47)、[ADR-0005](../adr/0005-two-path-display-pipeline.md) 和[验收约定](acceptance.md)。实现分支为 `ticket/47-viewer`，已合并集成分支中的基础检索与打标功能。

## 使用与显示路径

单击图片墙选中参考图，Ctrl／Shift 保留多选操作；再单击当前唯一选中的那张、双击或回车打开查看器（[#179](https://github.com/Yukk1No/kinshoko/issues/179)）。多选时不按修饰键单击其中一张只收缩为这一张。双击按第一下的图判定：系统双击间隔与判定范围内的第二下无论落在哪里（别的卡片、正在展开的详情侧栏），都打开第一下的那张；侧栏开合引起的重排等双击间隔过后才进行。查看器只盖住图片墙所在的区域，左栏与顶栏照常可用，在左栏换浏览范围即离开查看器；详情侧栏在旁边显示正在看的图，←/→ 跟着换，I 键、dock 的“详情”与右键菜单显示或隐藏它；缩放比例在查看器工具栏上，操作提示在设置 › 快捷键。滚轮以指针位置为中心缩放，拖动平移；“原图像素”表示一个原图像素对应一个设备像素。Esc 或“返回图片墙”回到图片墙：选择是最后查看的那张，侧栏开合不变，那张卡片滚入可见并获得焦点。

静态 SDR 在原图像素和放大时直接读取原文件，保留字节、ICC 与 EXIF。缩小时由 Rust 生成精确设备像素宽度的无损 WebP，显示尺寸除以 DPR；图片宽高和相对整个窗口的起点都按设备像素对齐。超过 200% 使用像素插值。连续缩放时等停手 120 ms 再换来源（缩小派生图与原图都一样）；同一时刻只等一张，读完再请求最新尺寸，快速反复缩放时 Rust 端不积压整图解码。等待期间，已读完的位图按当前位置与尺寸临时顶上（[#128](https://github.com/Yukk1No/kinshoko/issues/128)）：缩到 100% 以下时优先用缩小派生图，不让 Chromium 每帧重采样整张大原图；精确来源解码完才换上。静止时看到的仍只来自上面两条路，只有手势进行中的过渡帧由 Chromium 缩放。测量脚本见 [e2e/viewer-zoom-perf.mjs](../../e2e/viewer-zoom-perf.mjs)。

窗口变化用 FLIP 连续重排；侧栏宽度变化期间保持布局，结束后按最终宽度重排。自身锚定滚动不会重新捕获锚点。`prefers-reduced-motion` 关闭这些动画。

## 显示路径与 #45 还原度管线

查看器从不直接读原文件，只走 #45 的显示路线（ADR-0005）：

- 1:1 与放大：`Library::display(id)` → `DisplayFile { route: Original | SdrDerivative, path }`，前端 `displayUrl(libraryId, imageId)`（`thumb` 协议 `<资料库 id>/<参考图 id>/full`）。静态 SDR 原图交给 WebView2；动图、HDR、LUT 型 ICC 与 CMYK 换成原尺寸 `sdr` 派生图。
- 缩小（适应窗口等）：`Library::display_scaled(id, 目标设备像素宽度)`，前端 `displayScaledUrl(libraryId, imageId, px)`（`<资料库 id>/<参考图 id>/fit-<像素>`）。目标不小于原图宽度时等同 `display`；更小时由 `kinshoko_core::fidelity::render_sdr` 生成精确宽度的 `sdr` 派生图，与缩略图共用缓存目录和管线版本（`cache/thumbs/<管线版本>/sdr/`），可删除后重建。

派生图的解码、色彩管理、动图首帧与 HDR 判定全部由 `kinshoko_core::fidelity` 负责，查看器不另有实现。安全模式开启（`SafeModeChanged{on:true}`）或查询返回 `UnknownImage` 时，查看器关闭并回到图片墙。

## 自动验证

核心测试通过公开接口，使用真临时 SQLite 和文件。六项测试覆盖：静态 SDR 原图字节不变、精确尺寸与透明色块、缓存重建、EXIF 方向 1～8、三种动画的首帧、常见 HDR 标记在各缩放档的强制派生图分流、无效请求；安全模式测试确认被封印的图 `display`／`display_scaled` 都返回 `UnknownImage`。

前端覆盖 DPR 1／1.25／1.5／2、奇数尺寸、110% 缩放、超过 200% 的插值、工具栏偏移、连续滚轮请求、读取重试、拖动、键盘焦点和图片墙锚点。侧栏 1121→1369→1121 的往返及重复的自身滚动事件不会漂移。

原生冒烟脚本为 [e2e/viewer.mjs](../../e2e/viewer.mjs)，使用 WebView2／EdgeDriver 154.0.4258.53 和 tauri-driver 2.1.0。生成 41 张测试图，在独立应用 identifier、临时资料库及 WebView 用户数据目录运行，不下载模型、不修改开机自启。实测通过：

- 真实双击打开、回车打开和 Esc 返回；滚动到 720 CSS px 后返回时那张图仍在视口里并获得焦点。（#179 起查看会选中这张图并展开详情侧栏，图片墙按锚点重排，滚动位置不再逐像素保持。）
- #179：查看器只占图片墙区域，左栏、顶栏、详情侧栏可用；I 键开合详情侧栏；单击已选中的那张打开；清空选择后双击最右一列的卡片，侧栏展开期间第二下仍打开这一张。
- 适应窗口的解码尺寸等于显示设备像素尺寸；原图像素为 2400×1600，超过 200% 仍使用原图。
- 原图与派生图的起点对齐设备像素；四个随软件附带的字体文件实际加载成功。
- 收起／展开侧栏，原生窗口宽度 1050→1280 往返，同一锚点的偏移变化小于 1 CSS px。
- 开发机实际 DPR 约 1.104，以及 WebView2 的测试参数 DPR 1、1.5。测试参数仅用于本次 WebView2 实例，不改变 Windows 系统缩放。

原生测试同时发现并修复了已有的启动阻塞：在资料库插件的 `setup` 内注册对话框插件会重复等待 Tauri 插件锁，现统一在应用 Builder 注册。

![适应窗口的原生查看器](viewer-fit.png)

#179 方案 B 的正式程序截图（WebDriver 只截应用窗口，临时图库里是合成图）：选中态；查看态，详情侧栏开；查看态，详情侧栏关；多选态。

![选中态](viewer-179/1-selected.png)
![查看态，详情侧栏开](viewer-179/2-viewing-inspector-open.png)
![查看态，详情侧栏关](viewer-179/3-viewing-inspector-closed.png)
![多选态](viewer-179/4-multi-select.png)

运行方式（PowerShell，独立 identifier 避免与其他实例共用单实例锁）：

```powershell
npm ci
npm run vite:build
$env:TAURI_CONFIG = '{"identifier":"dev.kinshoko.viewer47test"}'
cargo build -p kinshoko --features tauri/custom-protocol
node e2e/viewer.mjs target/debug/kinshoko.exe <msedgedriver.exe> <tauri-driver.exe>
# 可选：只为本次测试设置 WebView2 缩放，另存截图和报告。
$env:KINSHOKO_VIEWER_DPR = '1.5'
$env:KINSHOKO_VIEWER_OUTPUT = 'work/viewer47-dpr15'
node e2e/viewer.mjs target/debug/kinshoko.exe <msedgedriver.exe> <tauri-driver.exe>
```

脚本在输出目录生成 `viewer.png` 和 `report.json`；失败时保存页面和截图。只清理自身创建且已校验路径的临时目录，并由 tauri-driver 的 Windows Job 结束本次测试的子进程。

## 缩放响应（#128）

2026-10-18，开发机（DPR 约 1.104，170 Hz），WebView2 155.0.4283.60，`tauri build --no-bundle` 独立 identifier 发行构建，窗口 1600×1000。合成 PNG 原图 1000／4000／8000 px（3:2）。脚本 [e2e/viewer-zoom-perf.mjs](../../e2e/viewer-zoom-perf.mjs) 每 16 ms 派发一格滚轮：放大（从适应窗口 24 格）、缩小（从原始像素 24 格）、扫动（约 3 s 来回 180 格，反复跨过 100%）。“冷”是每个场景在该图上的第一轮（扫动单独跑时才真正冷），“热”是紧接着的同一手势。滚轮由页面脚本派发，首次响应不含系统输入送达的延迟。修复前 2–3 轮，修复后 4–10 轮，取各轮范围。

| 8000 px | 首次可见响应 | 手势中空白帧 | 帧间隔 p95／p99 | 停手到精确图 |
|---|---|---|---|---|
| 放大，冷 | 1753–1875 ms → 3–6 ms | 100% → 0 | 6／6 → 6／≤6.3 | 1.80–1.98 s → 1.36–1.50 s |
| 放大，热 | 258 ms → 6 ms | 69% → 0 | 6／6 → 6／6 | 8–9 ms → 129–142 ms |
| 缩小，冷 | 1881–2145 ms → 5–6 ms | 100% → 0 | 6／6 → 6／6 | 1.52–1.79 s → 1.18–1.57 s |
| 缩小，热 | 500–505 ms → 6 ms | 100% → 0 | 6／6 → 6／6 | 141–143 ms → 136–141 ms |
| 扫动，冷 | 1217 ms → 5–6 ms | 77% → 0 | 6／11.7（最长 353 ms）→ 6／6（最长 11.6 ms） | — |

4000 px：首次响应 147–564 ms → ≤6 ms，空白帧 31–100% → 0，冷缓存停手 0.14–0.32 s → 0.43–0.58 s；1000 px 缩小首次响应约 0.5–0.6 s → ≤6 ms。修复后所有场景帧间隔 p95 ≤ 6 ms，p99 ≤ 6.3 ms；单帧最长 23.7 ms（4000 px 冷放大）与 100 ms（4000 px 冷扫动，各一次，未见复现）。另有一轮在其他会话并行编译 16 个 rustc 时测得 8000 px 热扫动 p99 29.6 ms，安静时复测三轮均为 6 ms，不计入。

8000 px 从原始像素连续缩小约 250 ms 时的窗口（`KINSHOKO_ZOOM_PERF_SNAPSHOT=out`），修复前与修复后：

![修复前：手势中只有“正在读取参考图…”](viewer-zoom-128-before.png)
![修复后：画面跟着滚轮缩小](viewer-zoom-128-after.png)

修复前帧间隔看似合格，是因为手势中图片被藏起来，没有东西可画。修复后：

- 停手到精确图仍受 Rust 整图解码约束（8000 px 冷缓存 1.2–1.6 s），但等待期间画面已在当前尺寸上；
- 热缓存放大的停手时间从约 10 ms 变为约 135 ms：原图也要等停手 120 ms 再换上，避免整张大图在手势中间第一次上屏（实测一帧 110–160 ms）；
- 缩到 100% 以下的替身优先用缩小派生图，不让 Chromium 每帧重采样整张原图（实测一帧 50–140 ms）。

## 工单验收状态

本工单以开发机上的自动测试和原生验证作为合并前验证。用户机复测只作兼容性记录，不阻塞 #47 合并。用户报告问题时，先对照下表中的未覆盖条件排查。

| 标准 | 已验证 | 兼容性记录（不阻塞合并） |
|---|---|---|
| 1:1／放大的颜色、方向、像素与原文件一致 | 原图不重编码、EXIF 1～8、设备像素尺寸与起点、插值规则 | ICC v2／v4、P3、Adobe RGB、LUT／CMYK、16 位 PNG、gAMA 与透明边缘尚未全面量化；出现颜色问题时对照原文件与屏幕配置 |
| 适应窗口显示派生图 | 核心精确尺寸测试和原生自然尺寸／显示尺寸比较 | 缩小的还原度由 #45 的还原度门槛（`--fidelity-gate`）衡量 |
| 动图与 HDR 全缩放使用 SDR 派生图 | GIF／APNG／WebP 首帧及常见 HDR 标记的分流（#45 管线） | HDR 显示器上的亮度一致性尚未验证 |
| 返回原位置、窗口与侧栏连续重排 | 单元测试和真实 WebView2 锚点、焦点、宽度往返 | 绘王数位板、用户机 Windows 100%／150% 系统缩放与动画观感尚未实测 |
| 随软件附带的字体生效 | Inter 400／500／600、思源黑体实际离线加载，许可随包分发 | 用户机上的中文阅读观感尚未实测 |

本地必须检查的命令为 `npm ci`、`npm run vite:build`、`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`、`npm run bindings`（生成目录无差异）、`npm run typecheck`、`npm test`。原生验证作为额外检查。后续用户机出现问题时，再补充对应样本、GPU、驱动、ICC、HDR、自动色彩管理、系统缩放或输入设备信息，供对照开发机结果定位问题。

以上八项检查均已通过，前端共 41 项、核心查看器共 6 项。Rust workspace 保留集成分支的两项 `ignored`：大库检索性能测量，以及只由故障注入父测试运行的子入口；其余测试均通过。
