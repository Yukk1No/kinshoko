# #81 / #78 T16：查看器与已有钉图的原图选区

2026-10-08。对应故事 45（查看器与已有库内钉图部分）、46、48、49。瀑布流来源登记由 T17 承接。

实施分支：`codex/spec-78-t16`。工作树：`spec78-t16-original-crop/kinshoko`。

生产实现提交：`8106d8aa2fbb164f59b5e29aa6cc81661ac96fda`。

原生测试 DPR 断言提交：`50d204ec6723e069930875e7cfd7ecade9244e9c`。该提交只增加测试断言；生产代码与上一提交一致。

起点为 `47e964ee16868c681e4db38252e3d5e3dd998d1e`，已合并集成文档提交 `49db028be84a33c10a3371983d832ad8703534a3`。本单记录自己的执行结果。#42、#71 和前置验收记录保持原有范围。

## 实现与可复用公开接口

复用前置实现的 `SavedPin::reference_region`、查看器来源报告、钉图可见范围及原生遮挡冻结、`ReferenceSource`、`PinVeils` 和 `ReferenceLens::display`。浏览结构与原型接入由 T01 记录。

[`CaptureSelection::finish`](../../crates/kinshoko-core/src/desktop/capture.rs) 是正式 F1 完成动作使用的核心公开接缝。请求提供冻结屏幕、显示器原点、物理像素选区与 `CaptureSurface` 列表。完成动作接收 `CaptureAction`、新钉图 ID、真实 `ReferenceSource`、当前 `PinVeils` 和 `CaptureHistory`。

- 选区完整位于唯一未遮挡参考图内时，钉住与复制共用 `SavedPin::reference_region` 得出的原图范围。
- 钉住返回 `PinReference(SavedPin)`。保留具体资料库、参考图、原图尺寸、裁切、翻转与旋转。窗口层负责新钉图位置和初始缩放。
- 复制返回 `CopyReference(RgbaImage)`。读取全尺寸 `ReferenceLens::display` 文件，按原图裁切，再按已有钉图的翻转、旋转方向输出。屏幕缩放不作用于最终复制内容。
- 动图、HDR、LUT／CMYK 等继续经既有显示规则取得原尺寸 SDR 派生图。静态 SDR 原图继续保留原文件字节。剪贴板接口只携带 RGBA8，因此复用还原度管线的色彩解释和 EXIF 转正，输出 sRGB RGBA8；原文件不改写。
- 有效库内选区不写截图历史。参考图尺寸变化、资料库不可用、原图缺失或重新遮蔽时返回错误。已逐张确认显示的钉图遵守现有 `PinVeils` 规则。
- 遮挡、可见范围外、跨出单张参考图、多个候选来源及外部区域沿用屏幕截图，并保留现有截图历史行为。

原生 adapter 继续核对窗口身份、已加载来源、冻结时的可见范围和原生遮挡。核心操作移到阻塞工作线程。持有桌面状态锁期间不调用窗口 API。

T17 可提供同一 `CaptureSurface` 列表并复用 `CaptureSelection::finish`。本单没有增加瀑布流来源登记。

## Red → Green

测试边界已由负责人确认：核心公开接口、真 SQLite 与真文件；正式程序端到端；开发者真机检查。测试位于 [`reference_capture_actions.rs`](../../crates/kinshoko-core/tests/reference_capture_actions.rs)。测试通过正式 `CaptureSelection::finish` 调用完成动作。

| 行为 | 观察到的 Red | Green 结果 |
|---|---|---|
| 缩小参考图复制取原图 | 提取的旧生产行为返回 30×20 屏幕像素；断言要求 120×80 原图像素 | 2400×1600 真图的选区返回 120×80；独立指定的细线、透明像素与原图坐标一致；钉图保留具体来源和相同裁切；历史仍为空 |
| 已有局部的方向与边界 | 复制返回未恢复方向的 103×51；断言要求 51×103 | 原有裁切起点、缩放、水平翻转、90° 旋转与整数向外取整得到原图 `[391,494) × [348,399)`；复制四角与独立 worked example 一致 |
| 多个可见候选来源 | 完成动作选择第一库的原图，未返回普通截图 | 多个候选走屏幕路径；内容和尺寸来自屏幕，新增截图历史 |

共 9 项公开动作测试通过。补充覆盖：当前资料库以外的明确来源、八种 EXIF 方向、gAMA 到 sRGB 转换、APNG 隐藏默认图片与 SDR 首动画帧、冻结后重新封印、逐张显示后重新开启安全模式、资料库未登记、来源尺寸变化、原文件缺失、遮挡、裁出可见范围与外部区域。全部使用真实资料库或实际截图历史文件。没有查询私有表来验证行为。

早期共享 `CARGO_TARGET_DIR` 曾发生并行工作树产物混用：应用编译误读了缺少新公开接口的另一份核心产物。随后改用本工作树自己的 `target`，重新执行全部 9 项测试、原生构建与后续检查。最终通过状态以独立目录的执行为准。早期 Red 保留为实际行为复现记录。

## 正式程序与真实剪贴板

使用 [`e2e/reference-capture.mjs`](../../e2e/reference-capture.mjs)。在独立 identifier `dev.kinshoko.spec78t16test`、临时资料库、临时 WebView 用户目录和 4457／4458 端口运行。设置 `KINSHOKO_SKIP_AUTOSTART=1`。未下载打标模型。每次只结束本次 driver 的 Windows Job，并清理已核对路径的测试临时目录。

脚本在正式程序中建库、导入 2400×1600 逐像素细节图并打开真实查看器。来源由实际 Viewer／PinView 报告。脚本通过正式 `start_capture`、`finish_capture` 命令开始与完成选区；冻结窗口真实显示。通过 `pin_frame` 核对来源、裁切与方向。复制后调用正式 `pin_clipboard` 从系统剪贴板读回，并检查写出的 PNG 四角像素。

环境：Windows 内核 `10.0.26300`；WebView2 与 EdgeDriver `154.0.4258.62`。

| 条件 | 查看器屏幕选区 | 原图／剪贴板选区 | 已有局部翻转、旋转后的剪贴板 | 结果 |
|---|---|---|---|---|
| 实际 DPR `1.1041666269302368` | 150×100 | 原图 `(598,399,300,200)`；剪贴板 300×200 | 原图范围 36×24；剪贴板 24×36，四角像素一致 | 13 项通过；2026-10-08 13:10:31 UTC |
| WebView 测试 DPR `1.5` | 145×96 | 原图 `(599,398,301,200)`；剪贴板 301×200 | 原图范围 37×24；剪贴板 24×37，四角像素一致 | 14 项通过；2026-10-08 13:11:41 UTC |

两个条件下，查看器及已有变换局部的钉住、复制都保持具体原图来源且不新增截图历史。F3 读回剪贴板时才增加历史。参考图外的 F1 复制继续生成屏幕尺寸的截图历史。

持久化的运行摘要、提交、实际来源与像素记录见 [`spec-78-t16-native.json`](spec-78-t16-native.json)。本机完整报告和剪贴板 PNG 分别保存在 `work/native/reference-capture/`、`work/native/reference-capture-dpr15/`。

## 本单自动检查

使用本工作树自己的 `CARGO_TARGET_DIR`。后续 Cargo 命令设置 `CARGO_BUILD_JOBS=2`。

| 检查 | 结果 |
|---|---|
| `cargo test -p kinshoko-core --test reference_capture_actions --locked -- --nocapture` | 9 项通过 |
| `cargo build -p kinshoko --features tauri/custom-protocol --locked` | 通过；独立 identifier 原生程序 |
| `npm run vite:build` | 通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 23 个文件，211 项通过 |
| `cargo fmt --all --check` | 通过 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo test --workspace --locked -- --test-threads=2` | 通过；全工作区测试退出码 0 |
| Rust 导出绑定与 `src/bindings` 提交内容核对 | 工作区导出测试通过；`git diff -- src/bindings` 为空 |
| `node --check e2e/reference-capture.mjs` | 通过 |
| 正式程序原生端到端 | 实际 DPR 13 项、测试 DPR 1.5 14 项通过 |

## 未验证项

开发者手工真机检查尚未执行。以下项目保持未验证：真实外部应用窗口遮挡、透明／特殊原生窗口、WinTab／Windows Ink 输入、实际全局 F1 物理按键、Windows 系统 DPI 变更、混合 DPI 多显示器切换、Windows 10 兼容性、广色域／HDR 显示器上的剪贴板色彩目视或仪器对比。

DPR 1.5 使用 WebView 启动参数，Windows 显示设置未改变。核心遮挡输入与来源失效检查已通过；这不代替原生外部窗口遮挡的手工检查。瀑布流滚动、虚拟列表回收与重排由 T17 单独验证。前置还原度门槛与发布验收状态继续由原工单记录。
