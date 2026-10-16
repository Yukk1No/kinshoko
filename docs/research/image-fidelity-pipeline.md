# 图片还原度管线与 HDR 预留核查

核查日期：2026-10-06。用途：回应“管线以最佳还原度为最高优先级，后续路线要能支持 HDR”这一新要求，给出首版图片显示、缩略图与桌面钉图的建议管线，并确认哪些选择会把 HDR 堵死。只阅读固定版本／commit 的源码、规范与官方文档；**没有构建、运行或测量任何东西**，下文的门槛与性能判断全部未经实测。

前提沿用已定事项：Tauri 2＋WebView2，原图不重编码、以哈希命名保存并经 asset 协议显示；缩略图是可重建缓存，键含内容哈希、目标像素与管线版本。本文与 [PR #10](https://github.com/Yukk1No/kinshoko/pull/10) 中 `image-pipeline-reuse.md` 的提案对照：其“不自己写色彩转换”与“原图、缩略图颜色分别验收”继续成立；“只放行 sRGB／无标记，ICC 等门槛不过就转 libvips”则改为由现成 Rust 色彩管理库直接补上门槛，libvips 降为备选，见第 2 节。

术语沿用 [GLOSSARY.md](../../GLOSSARY.md)：参考图、参考视图、桌面钉图、截图。

源码固定点：

- Chromium `main` @ [`55249a58`](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7)（2026-10-06 读取；WebView2 稳定版当前为 154，见下文 #5734，二者不是同一构建，行为仍须在 WebView2 上实测）。
- Skia `main` @ [`00987348`](https://skia.googlesource.com/skia/+/00987348988a7355d6437a917fa153dde9ce6c82)。
- `image` 0.25.10（2026-03-10，tag 指向 `76e57184`）、`moxcms` 0.9.1（2026-09-15）、`fast_image_resize` 6.1.0（2026-07-21）、`lcms2` 6.2.0、`qcms` 0.3.0（2024-01-09）；版本与日期取自 crates.io API。
- libvips 8.18.7（2026-09-26）。

## 结论与建议

**核心原则（推论）：画师看到的每一个像素，要么是 WebView2 对原文件的直接解释，要么是按“与 WebView2 相同的颜色解释规则”在 Rust 侧生成、再以设备像素 1:1 交给 WebView2 的派生图。** 这样颜色转换只有一处“到屏幕”的出口（Chromium 自己的显示色彩空间），缩放只有一处自有实现（Rust 侧），两者都可以单独验收、单独升级。

| 环节 | 首版建议 | 理由（证据见后文） | HDR 预留 |
|---|---|---|---|
| 原图显示（1:1 及放大） | `<img>`＋asset 协议，尺寸按设备像素整数对齐；放大检查像素时可选 `image-rendering: pixelated` | Chromium 对 JPEG／PNG／WebP 的嵌入 ICC、PNG cICP/sRGB/gAMA/cHRM、CMYK＋CMYK 配置文件均有处理路径，并转换到显示器色彩空间 | 同一路径已有增益图、PQ/HLG 与 HDR 显示（scRGB／HDR10 输出）代码；原图不重编码即可保留 HDR 数据 |
| 原图缩小显示（适应窗口等） | 用 Rust 管线生成“屏幕尺寸派生图”，以 1:1 显示；不交给 Chromium 缩小 | Chromium 的缩小滤镜在本文未核实，且在编码值（非线性）上运算；`createImageBitmap` 的 high 质量是单次 Catmull-Rom，对大倍率缩小没有预滤波（推论） | 派生图与缩略图同属可重建缓存，按管线版本失效 |
| 缩略图解码 | `image` 0.25.10，只开 `jpeg,png,webp,gif`；CMYK JPEG 另走保留 CMYK 采样的路径 | `image` 自身对 CMYK JPEG 只做朴素 RGB 转换、不读 ICC | 以后按需加 AVIF／JXL／增益图解码器 |
| 缩略图色彩 | `moxcms` 0.9.1：按与 Chromium 相同的优先级取得来源色彩声明，转到线性光工作空间（f32） | 支持 ICC v2/v4、LUT（mAB/mBA）、CMYK、CICP，含 PQ/HLG 预设；纯 Rust，BSD-3／Apache-2.0；`image` 0.25.10 已依赖它 | 同一库可做 PQ/HLG／BT.2020 转换 |
| 缩略图缩放 | `fast_image_resize` 6.1.0，F32 像素、预乘 alpha（默认开启）、Lanczos3（默认）；画师对比后可改 Mitchell 等 | `image` 的 `resize` 要求调用方先预乘并处于线性光；直接用会在透明边与细线上出错 | f32 工作区不限制超出 1.0 的 HDR 值 |
| 缩略图存储 | 无损：sRGB 来源→8 位无损 WebP；广色域→8 位无损 WebP＋ICC（保留来源矩阵型 ICC，或转为 Display P3）；16 位来源→16 位 PNG＋iCCP | 有损 WebP（VP8）只有 4:2:0 色度抽样，会损伤动漫线稿的彩色细线；`image` 的 WebP 编码器只有无损、可写 ICC | HDR 缩略图以后用 16 位 PNG＋cICP（Chromium 优先读 cICP）或增益图；缓存键加“动态范围变体” |
| 桌面钉图（库内局部） | canvas 2D，按物理像素定尺寸，sRGB 色彩空间、`colorType: 'float16'`（原建议 `display-p3`，#62 实测改）；缩小时从 Rust 派生图取样，放大时 `imageSmoothingQuality='high'` 或关闭平滑 | 默认 sRGB canvas 会把广色域图裁到 sRGB；`imageSmoothingQuality` 默认 `low` | 渲染层抽象成接口，HDR 时换 WebGPU `rgba16float`＋`toneMapping: 'extended'`（M129 已默认开启） |
| 截图钉图 | 截图时记录屏幕颜色状态（普通 SDR＋显示器 ICC／Windows 自动色彩管理／HDR），按采集格式无损保存并标注相应色彩空间，使回显在原屏幕上为恒等变换 | “未缩放时与屏幕像素一致”要求回显不能再做一次 sRGB→显示器转换 | HDR 桌面需 FP16 scRGB 采集＋WebGPU 扩展范围显示 |
| WebView2 参数 | 默认**不**加 `--force-color-profile`；保留一个需重启生效的诊断开关 | 强制 sRGB 会放弃显示器 ICC 校正；但 WebView2 154 存在显示色彩空间回归（偏黄），需要逃生口 | 同一开关以后可用于强制 scRGB 等诊断 |

为 HDR 现在就要做的事（都很便宜）：

1. 原图字节永不改写（已定）；Ultra HDR／ISO 21496-1 增益图、PQ/HLG、MDCV/CLLI 都随原字节保留。
2. 导入时记录颜色描述：格式、位深、颜色模型（RGB／灰度／CMYK）、色彩声明来源（ICC／cICP／sRGB 块／gAMA+cHRM／无）、ICC 哈希、版本与类型（矩阵型／LUT 型）、alpha、EXIF 方向、HDR 标记（PQ/HLG、增益图、MDCV/CLLI）、是否动图。以后据此只重建受影响的派生图。
3. 派生图缓存键：内容哈希＋目标像素＋管线版本＋动态范围变体（`sdr`／`hdr`）。
4. 所有中间计算用 f32 线性光，不在 8 位整数上做色彩或缩放运算；8 位只出现在最终编码。
5. 显示路径（图库、查看器、钉图）收敛到一个可替换的渲染接口，首版实现为 `<img>`／canvas 2D，HDR 时换 WebGPU。

与 PR #10 提案相比的变化：不再把“ICC／非 sRGB 门槛不过就转 libvips”作为主路线，而是 `image` 只负责解码与方向，色彩交给 `moxcms`，缩放交给 `fast_image_resize`；libvips 降为备选（第 2 节说明取舍）。“不自己写色彩转换”仍然成立：自写部分只是选择配置文件、按 Chromium 规则排定优先级，以及预乘／反预乘的胶水。

## 1. WebView2／Chromium 的颜色管理

### 1.1 解码时如何解释图片的色彩声明（已核实源码）

| 格式／情形 | Chromium 行为 | 证据 |
|---|---|---|
| JPEG＋ICC | 解析嵌入 ICC；YCbCr/RGB 图只接受 RGB 配置文件，灰度图接受灰度或 RGB 配置文件，CMYK/YCCK 图只接受 CMYK 配置文件；不匹配则丢弃配置文件按 sRGB 处理 | [jpeg_image_decoder.cc#473](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/jpeg/jpeg_image_decoder.cc#473) |
| CMYK JPEG 无配置文件 | 按 Adobe 反相 CMYK 做朴素公式 `R = C·K/255` 转换，无色彩管理 | 同文件 [#1136](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/jpeg/jpeg_image_decoder.cc#1136) |
| PNG | 解码器已换为 Skia 的 Rust PNG 解码器 `SkPngRustDecoder`。色彩优先级：cICP（矩阵系数 0 且全范围）→ iCCP → sRGB 块 → gAMA＋cHRM；只有 gAMA 时用 sRGB 原色加该 gamma；gAMA 缺失时不猜，cHRM 被忽略；同时读取 MDCV/CLLI | [png_image_decoder.cc](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/png/png_image_decoder.cc)、[SkPngRustCodec.cpp#141](https://skia.googlesource.com/skia/+/00987348988a7355d6437a917fa153dde9ce6c82/src/codec/SkPngRustCodec.cpp#141) |
| WebP | 静态图读取 ICCP 块，仅接受 RGB 配置文件；动图的 ICC 目前被丢弃（源码 FIXME） | [webp_image_decoder.cc#362](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/webp/webp_image_decoder.cc#362)、[#502](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/webp/webp_image_decoder.cc#502) |
| 嵌入配置文件后的处理 | `ColorBehavior::kTag` 时把图片标记为配置文件对应的 `SkColorSpace`；配置文件不能被 `SkColorSpace` 精确表示（如 LUT 型、CMYK）时，在解码阶段先变换像素 | [image_decoder.cc#1065](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/image_decoder.cc#1065) |
| 高位深（16 位 PNG、10/12 位 AVIF 等） | 解码器报告高位深时，按 `RGBA_F16` 生成 SkImage | [deferred_image_decoder.cc#134](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/graphics/deferred_image_decoder.cc#134) |
| AVIF、增益图 | AVIF 由 CrabbyAvif 解码并读取 CICP 与增益图；JPEG 解码器也有增益图辅助图像路径 | [avif_image_decoder.cc](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/avif/avif_image_decoder.cc)、[jpeg_image_decoder.cc#860](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/jpeg/jpeg_image_decoder.cc#860) |

Blink 的 image-decoders 目录只有 avif、bmp、gif、ico、jpeg、jxl、png、webp 子目录，没有 HEIF／HEIC 解码器（[目录列表](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/platform/image-decoders/)）。ICC v2 与 v4（含 A2B LUT）的解析由 Skia 侧完成；WebP 解码器注释直接提到 `skcms_Transform`。本文没有逐行核对 skcms 对每种 v4 标签的支持范围，列为待测。

### 1.2 转换到显示器（已核实源码＋官方文档）

Chromium 在 Windows 上为每个显示器选择显示色彩空间（[screen_win.cc#303](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/ui/display/win/screen_win.cc#303)）：

- 有 `--force-color-profile` 时用强制值；
- HDR 开启时，SDR 内容用 sRGB，并把 Windows 的 SDR 参考白（`DISPLAYCONFIG_SDR_WHITE_LEVEL`，读不到时默认 200 nit）设为 SDR 最大亮度；广色域与 HDR 内容使用 scRGB 线性 FP16 或 HDR10（RGB10A2）缓冲，需要 alpha 时用 FP16（[#131](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/ui/display/win/screen_win.cc#131)、[#219](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/ui/display/win/screen_win.cc#219)）；
- 否则用 `GetICMProfile` 取得的显示器 ICC（[color_profile_reader.cc](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/ui/display/win/color_profile_reader.cc)）。

Windows 侧（[Advanced Color 文档](https://learn.microsoft.com/en-us/windows/win32/direct3darticles/high-dynamic-range)、[ICC 行为文档](https://learn.microsoft.com/en-us/windows/win32/wcs/advanced-color-icc-profiles)）：

- 未启用 Advanced Color 时，系统不做颜色管理，应用输出被当作已在显示器空间。
- 启用 Advanced Color（HDR 显示器，或 Windows 11 22H2 起经过配置文件供给的 SDR 显示器的“自动色彩管理”）时，DWM 用 FP16 scRGB 合成；8 位整数格式的普通应用被当作 sRGB；超出显示器色域的颜色被数值裁切；此时 ICC 管理 API 对显示器“返回无配置文件”，按约定视为 sRGB。
- 兼容助手“使用旧版显示器 ICC 颜色管理”按进程启用，只能由用户在 exe 属性中勾选，没有编程方式。

推论：在 Windows 自动色彩管理（SDR）下，Chromium 读到“无配置文件”，把显示器当作 sRGB，再由 DWM 转到显示器，结果是广色域图片被限制在 sRGB 内。Chromium 有对应议题 [328856550](https://issues.chromium.org/issues/328856550)（标题即“自动色彩管理下广色域图片被裁到 sRGB”；正文需登录，本文未读到）。WebView2 的渲染与 GPU 进程是 `msedgewebview2.exe`，在 Kinshoko 的 exe 上勾选兼容助手是否作用到这些进程，**未核实且存疑**。HDR 模式下走 scRGB，广色域应能保留，但同样未在 WebView2 中实测。

### 1.3 canvas、`createImageBitmap`、CSS 与视频

- 2D canvas 的颜色管理已于 M94 默认开启：所有输入转换到 canvas 色彩空间，可选 `display-p3`（[chromestatus 5807007661555712](https://chromestatus.com/feature/5807007661555712)）。规范规定 canvas 输出到设备时的转换与同色彩空间 `<img>` 相同；`imageSmoothingQuality` 默认 `low`；`float16` 的 canvas 序列化为 PNG 时用 16 位，超出 [0,1] 的值被裁切（[HTML 规范 canvas 一节](https://html.spec.whatwg.org/multipage/canvas.html#colour-spaces-and-colour-correction)）。**推论：默认 sRGB canvas 绘制 Display P3 图片时会丢失 sRGB 以外的颜色。**
- 浮点 canvas（`colorType: 'float16'`）在 chromestatus 的发布阶段记为桌面 M137 起，但实现状态字段仍为 Proposed（[5086141338877952](https://chromestatus.com/feature/5086141338877952)）；`srgb-linear`／`display-p3-linear` 记为 M155 发布阶段，状态 Proposed（[5122501071994880](https://chromestatus.com/feature/5122501071994880)）；canvas HDR 显示仍在开发（[5703719636172800](https://chromestatus.com/feature/5703719636172800)），canvas 目标 HDR 余量为 Proposed（[5858435803119616](https://chromestatus.com/feature/5858435803119616)）。WebView2 154 中是否可用须实测。
- `createImageBitmap`：`colorSpaceConversion: 'default'` 以 `kTag` 解码、`'none'` 忽略色彩声明；`resizeQuality: 'high'` 映射到 Skia `CatmullRom` 三次采样，`medium` 为双线性＋最近 mip 级，`low` 为双线性无 mip（[image_bitmap.cc#161](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/third_party/blink/renderer/core/imagebitmap/image_bitmap.cc#161)、[paint_flags.cc#178](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/cc/paint/paint_flags.cc#178)）。推论：4×4 固定支撑的三次采样在大于约 2 倍的缩小中没有预滤波，细线与网点会出现混叠；微软对 WIC 普通 Cubic 与 HighQualityCubic 的区分说明了同一问题（[WIC 插值模式](https://learn.microsoft.com/en-us/windows/win32/api/wincodec/ne-wincodec-wicbitmapinterpolationmode)）。
- CSS 颜色与 `<img>` 走同一显示色彩空间（规范层面见 [CSS Color 4](https://www.w3.org/TR/css-color-4/)）；`dynamic-range-limit` 已在 M136 默认开启，可限制 HDR 内容亮度（[5146250411769856](https://chromestatus.com/feature/5146250411769856)）。
- 视频不在首版范围。HDR／广色域视频与图片共享上面的 scRGB／HDR10 输出缓冲选择。

### 1.4 WebView2 专属事项

- 浏览器参数：`AdditionalBrowserArguments` 直接作为浏览器进程命令行；同一开关重复时只取最后一个，`--enable-features`／`--disable-features` 会合并（[ICoreWebView2EnvironmentOptions](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions)）。Tauri 窗口配置 `additionalBrowserArgs` 会覆盖 wry 默认的 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，设置时须自行带上（[tauri-utils config.rs#L1759](https://github.com/tauri-apps/tauri/blob/tauri-v2.8.5/crates/tauri-utils/src/config.rs#L1759)）。
- `--force-color-profile` 让所有显示器按指定配置文件处理（[display_switches.cc#23](https://chromium.googlesource.com/chromium/src/+/55249a58908974bfdbc9f01b1448b3c4389a44f7/ui/display/display_switches.cc#23)）。设为 `srgb` 等于放弃显示器 ICC 校正，不宜默认开启。
- **当前回归**：[WebView2Feedback #5734](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5734)（2026-09-29 开启，标记 bug／regression，仍开放）报告 WebView2 Runtime 154.0.4258.37 起，HDR 关闭的广色域显示器上所有 WebView2 应用整体偏黄，报告者测得 `#FFFFFF` 显示为约 (221, 220, 193)；环境为 Windows 11 25H2，复现应用包括 Tauri 应用；`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-color-profile=srgb` 或开启 HDR 可恢复中性。后续评论在使用自定义显示器 ICC 的机器上复现，移除该 ICC 后恢复；也有人报告该环境变量无效。关联 Chromium 议题 566216548，本文未读到正文。含义：**WebView2 是常青运行时，颜色行为会随系统更新改变**，验收必须记录 Runtime 版本，并在每次大版本更新后复测。

## 2. 缩略图方案比较

缩略图的还原度包括两件事：与 WebView2 显示原图的颜色一致，以及缩小本身的质量（混叠、线条粗细、透明边）。

| 方案 | 颜色与原图一致 | 缩小质量 | CMYK／16 位／方向 | 体积、许可、维护 |
|---|---|---|---|---|
| (a) `image`＋`moxcms`＋`fast_image_resize` | 取决于是否按 Chromium 的规则选择配置文件（可做到）；CMS 实现不同（moxcms vs skcms），预期差异在舍入级，须测 | 可完全控制：f32、线性光、预乘、Lanczos3 等 | `image` 的 CMYK JPEG 只朴素转 RGB；16 位与 EXIF 方向（含 PNG eXIf）可用 | 纯 Rust，MIT／Apache-2.0／BSD-3；体积增量未测；`image` 已依赖 `moxcms` |
| (a′) 用 `lcms2` 或 `qcms` 代替 `moxcms` | 同上 | 同上 | `lcms2` 成熟完整；`qcms` 的 ICC v4 与 CMYK 都在 Cargo feature 后面 | `lcms2` crate MIT，捆绑 C 版 Little CMS；`qcms` 最近发布 2024-01 |
| (b) libvips | ICC 由 lcms2 处理；默认非线性缩放，`linear` 选项可在 XYZ PCS 或 scRGB 中缩放；先预乘再缩放 | 好（`vips_resize`），带预缩小 | CMYK、16 位、自动旋转、增益图缩放都有 | Windows 预编译包 x64 web 版 zip 约 8–10 MB；分发条款按构建说明为 LGPLv3；需 C 绑定与 DLL 部署 |
| (c) WebView2 自己解码缩小 | 解码与色彩解释与原图完全相同（最大优势） | `resizeQuality` 最高为单次 Catmull-Rom，编码值空间，大倍率缩小混叠（推论）；要好的结果需逐级减半等技巧 | 与原图相同；输出须经 canvas（默认 sRGB 8 位会裁色域）再 `toBlob` 编码 | 零依赖；但只能在渲染进程、窗口存在时批量运行，内存与吞吐受 WebView 限制 |
| (d) Windows WIC＋`IWICColorTransform` | 系统 CMS，与 Chromium 不同；对 ICC v4 LUT 的支持本文未核实 | `HighQualityCubic`（Windows 10 起）为缩放感知核；文档未提线性光 | 颜色变换支持 CMYK、64bpp 等像素格式 | 系统自带、零体积；WebP 依赖系统编解码器扩展（未核实）；行为随系统版本 |

证据：

- `image` 0.25.10：JPEG 解码时，非 RGB／灰度的色彩空间一律要求 zune-jpeg 输出 RGB（[decoder.rs#L47-L57](https://github.com/image-rs/image/blob/v0.25.10/src/codecs/jpeg/decoder.rs#L47-L57)）；PNG 只提供 `gamma_value()`，且 sRGB 块存在时忽略 gAMA（[png.rs#L124-L137](https://github.com/image-rs/image/blob/v0.25.10/src/codecs/png.rs#L124-L137)）；图像的色彩空间只以 CICP 表示，`resize`／`thumbnail` 直接在通道值上运算，“假定 alpha 已预乘、输入为线性光”，读写函数尚不写出 ICC／CICP 标记（[DynamicImage 文档](https://docs.rs/image/0.25.10/image/enum.DynamicImage.html)、[sample.rs#L960-L963](https://github.com/image-rs/image/blob/v0.25.10/src/imageops/sample.rs#L960-L963)）；编码器 trait 可写 ICC，WebP 编码器只有无损（[webp/encoder.rs](https://github.com/image-rs/image/blob/v0.25.10/src/codecs/webp/encoder.rs#L12)）；依赖 `moxcms 0.8.0`（[Cargo.toml#L40](https://github.com/image-rs/image/blob/v0.25.10/Cargo.toml#L40)）。
- `moxcms` 0.9.1：源码含 mAB/mBA LUT 读取、渲染意图、CICP，以及 `new_display_p3`、`new_display_p3_pq`、`new_bt2020_pq`、`new_bt2020_hlg` 等预设；Rust ≥ 1.89；源码中 `unsafe` 出现 276 处（多为 SIMD，未审计）（[docs.rs](https://docs.rs/moxcms/0.9.1/moxcms/)、[defaults.rs](https://docs.rs/crate/moxcms/0.9.1/source/src/defaults.rs)）。README 没有与 lcms2／skcms 的精度对比，精度须自测。
- `fast_image_resize` 6.1.0：`ResizeOptions` 默认 `Convolution(Lanczos3)` 且 `mul_div_alpha: true`；提供 `create_srgb_mapper()` 在 sRGB 与线性之间转换；支持 U16／F32 像素（[resizer.rs](https://docs.rs/crate/fast_image_resize/6.1.0/source/src/resizer.rs)、[mappers.rs](https://docs.rs/crate/fast_image_resize/6.1.0/source/src/color/mappers.rs)）。
- libvips 8.18.7 `thumbnail.c`：`linear` 模式有嵌入 ICC 时导入到 XYZ PCS 缩放，否则转 scRGB；非线性模式在 sRGB 中缩放；有 alpha 时预乘；增益图随主图缩放（[thumbnail.c#L747](https://github.com/libvips/libvips/blob/v8.18.7/libvips/resample/thumbnail.c#L747)、[#L832](https://github.com/libvips/libvips/blob/v8.18.7/libvips/resample/thumbnail.c#L832)）。Windows 预编译包与依赖许可见 [build-win64-mxe README](https://github.com/libvips/build-win64-mxe/blob/v8.18.7/README.md) 与 [v8.18.7 发布](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.7)；web 版包含 lcms 2.19.1 与 libultrahdr 2.0.2。
- WIC：[`IWICColorTransform::Initialize`](https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccolortransform-initialize) 列出支持的像素格式，包括 32bppCMYK 与 64bppRGBA。

**建议：(a) 作首版主路线。** 理由（推论）：它是唯一同时满足“色彩由成熟 CMS 处理”“缩放可做线性光与预乘”“纯 Rust、无 DLL 与 LGPL 部署成本”的方案；颜色一致性靠“镜像 Chromium 的解释规则”而不是靠同一个 CMS，残差需由“尚未验证”一节的实验 1–4 量化。(c) 保留为**对照基准**：门槛测试中用它读出 Chromium 对同一原图的颜色，作为 (a) 的期望值。(b) 是 (a) 在 CMYK 或精度上不过关时的替代；(d) 不建议，因为与 Chromium 不同源、行为随系统变化。

需要自写的胶水（不是色彩算法）：

1. 色彩声明解析，顺序镜像 Chromium：PNG 用 `png` crate 直接读 cICP／iCCP／sRGB／gAMA／cHRM；JPEG／WebP 按颜色模型检查 ICC 类型，类型不匹配则按 sRGB；无声明按 sRGB。
2. CMYK JPEG：需要拿到原始 CMYK 采样再交给 moxcms；`image` 的封装做不到，要直接调用 zune-jpeg 或换解码器（API 未核实）。无 CMYK 配置文件时，按 Chromium 的朴素公式处理以保持一致。
3. 预乘与反预乘、f32 与 8／16 位之间的量化（四舍五入，不抖动，保证可重复）。

**线性光缩小是否等于“还原”，需要画师判断。** 线性光平均在物理上正确，但白底黑细线缩小后会比在编码值空间中缩小显得更浅、更细；绘画软件与浏览器多在编码值空间缩放（本文未核实优动漫的做法）。建议首版默认线性光，同时把“编码值空间”作为管线参数，用“尚未验证”一节的实验 6 由画师对比决定；改变即升管线版本。

## 3. 缩略图存储格式

| 选项 | 还原度 | HDR 含义 |
|---|---|---|
| sRGB 8 位（转换后丢掉来源色彩空间） | 广色域来源被裁切，与原图不一致 | 需全部重建 |
| 保留来源矩阵型 ICC 或 Display P3，8 位无损 WebP＋ICC | 与原图一致；8 位在宽色域下量化稍粗 | SDR 足够；HDR 另建变体 |
| 16 位 PNG＋iCCP／cICP | 最高；文件大 | Chromium 优先读 PNG cICP，可直接表达 BT.2020 PQ/HLG |
| 有损 WebP | 有损部分是 VP8（[RFC 9649](https://www.rfc-editor.org/rfc/rfc9649)），VP8 只用 8 位 YUV 4:2:0（[RFC 6386 §2](https://www.rfc-editor.org/rfc/rfc6386#section-2)），损伤彩色细线 | 不适用 |
| AVIF 10/12 位 | 好；Rust 编码慢，`image` 的 AVIF 编码位深未核实 | 支持 PQ/HLG、增益图 |
| JPEG XL | 最适合（无损／高位深／HDR） | WebView2 尚不默认支持：Chrome 145 起在 flag 后，chromestatus 发布阶段记为 M155、状态 Proposed（[5114042131808256](https://chromestatus.com/feature/5114042131808256)） |

建议首版按来源分档：sRGB／无声明／灰度→8 位无损 WebP 不带 ICC（与原图同按 sRGB 解释）；矩阵型 RGB ICC→同一 ICC＋8 位无损 WebP，ProPhoto 一类极宽色域或 16 位来源改 16 位 PNG；LUT 型、CMYK→转换到 Display P3（或在实验中发现裁切时用 BT.2020）16 位 PNG＋ICC。体积与解码耗时未测，须在画师图库上量（实验 9）。HDR 来源首版只生成 SDR 缩略图（基础图或色调映射），并打上 `hdr` 标记，以后生成 `hdr` 变体，不覆盖 `sdr` 变体。

## 4. HDR 现状与预留

| 格式 | Chromium／WebView2 | Rust | 对画师的相关性（推论） |
|---|---|---|---|
| Ultra HDR／ISO 21496-1 增益图 JPEG | JPEG、AVIF 解码器有增益图路径（见 1.1）；在 HDR 显示上的实际效果未测 | `ultrahdr-rs` 0.4.0（Apache-2.0，成熟度未评估）；libvips 8.18 通过 libultrahdr | 高：手机拍的照片参考常带增益图 |
| AVIF PQ/HLG | 读取 CICP 与增益图 | `image` 0.25.5 起解码 10/12 位 AVIF（[CHANGES](https://github.com/image-rs/image/blob/main/CHANGES.md)），需原生 dav1d | 中 |
| PNG cICP | 优先于 iCCP；读取 MDCV/CLLI（已核实） | `png` crate 读写 cICP 的 API 未核实 | 中：可作 HDR 缩略图容器 |
| JPEG XL | flag 后；目标 M155 | `jxl-oxide` 0.12.6；Chromium 用的 `jxl-rs` | 中，取决于默认开启时间 |
| HEIC（iPhone） | Blink 无 HEIF 解码器 | 需 libheif（LGPL） | 高但首版不支持；导入时应明确报不支持，而不是生成错误缩略图 |
| OpenEXR／Radiance | 浏览器不显示 | `image` 默认格式含 `exr`、`hdr` | 低 |

HDR 显示路径：WebGPU 的 `toneMapping: { mode: 'extended' }` 已在 M129 默认开启，允许 `rgba16float` 画布超出 SDR 白（[chromestatus 6196313866895360](https://chromestatus.com/feature/6196313866895360)、[Chrome 博客](https://developer.chrome.com/blog/new-in-webgpu-129)）；WebGPU 导入 HDR 纹理仍为 Proposed，因此 HDR 图要么交给 `<img>`，要么在 Rust 侧解码成浮点数据再上传。

截图钉图在 HDR 桌面：DWM 在 HDR 模式以 FP16 scRGB 合成，1.0 对应 80 nit，用户设定的 SDR 参考白通常约 200 nit；Windows.Graphics.Capture 等可指定像素格式的采集 API 可无损采集 HDR／广色域内容（[Advanced Color 文档](https://learn.microsoft.com/en-us/windows/win32/direct3darticles/high-dynamic-range#capturing-hdr-and-wcg-screen-content)）。推论：HDR 桌面上要做到“与屏幕一致”，需要 FP16 采集、无损保存（如 16 位浮点格式或 JPEG XR／EXR 一类）并以 WebGPU 扩展范围回显；8 位采集在 HDR 桌面上得到的是何种映射，文档未说明，须实测。

普通 SDR 桌面的推论：屏幕帧缓冲里已经是“显示器空间”的值（Chromium 已转换过，未管理的应用直接写入）。若把截图当作 sRGB 回显，WebView2 会再做一次 sRGB→显示器转换，在装有非 sRGB 显示器 ICC 的机器上就不再一致。因此截图应标注为截取当时的显示器配置文件（Windows 自动色彩管理或无配置文件时为 sRGB），让回显成为恒等变换；显示器、配置文件或 HDR 状态改变后，截图如实按其标注颜色显示，而不是追随新屏幕。

## 5. 桌面钉图的渲染方式

| 方式 | 重采样 | 颜色管理 | HDR |
|---|---|---|---|
| `<img>`＋CSS 变换 | 由合成器决定，滤镜未核实；非整数 DPR 下难以保证与设备像素对齐（原型教训） | 与原图显示相同，最一致 | 随 Chromium 的 HDR 图片支持 |
| canvas 2D | `drawImage` 可选 `imageSmoothingQuality`（最高为三次采样，缩小有混叠）或关闭平滑；整数平移、90° 旋转与翻转可做到逐像素精确 | 全部转换到 canvas 色彩空间：默认 sRGB 会裁广色域，须用 `display-p3`；float16 待实测 | 需要 float16 与 HDR canvas，尚未就绪 |
| WebGL／WebGPU | 着色器完全自控：线性光、Lanczos／EWA 旋转、mip 预滤波 | 自己负责：导入纹理时的色彩转换须显式处理 | WebGPU 扩展范围 M129 已默认开启 |

建议：首版钉图用 canvas 2D（物理像素尺寸、sRGB `float16`；原建议 `display-p3`，#62 实测在 110% 缩放的 sRGB 屏上约一半像素偏 1–8 级，sRGB canvas 与 `<img>` 逐像素一致），缩小时用 Rust 派生图作为源以避免混叠，放大与旋转交给 canvas；把“钉图渲染器”做成接口，HDR 或更高质量旋转时换 WebGPU 实现。WebGPU 在 WebView2 中可能因 GPU 黑名单不可用，必须保留 canvas 2D 回退（推论，未核实 WebView2 的 WebGPU 启用条件）。

## 尚未验证

以下全部未做。建议作为首个实现工单的门槛测试，在画师电脑与开发机（记录 GPU、驱动、Windows 版本、WebView2 Runtime 版本、显示器 ICC、HDR／自动色彩管理状态）上执行，样本与结果哈希入库。

**读取 Chromium 颜色的方法**：在 WebView2 中用 `createImageBitmap(blob)` 加载图片，画到 `{colorSpace: 'display-p3'}` 的 canvas，再以 `getImageData(..., {colorSpace: 'display-p3'})` 读回；对 Rust 缩略图做同样读取，比较色块平均值的 ΔE2000。这测的是“解释是否一致”，不涉及显示器。显示器上的最终效果另用色度计或画师目视。

需构造的样本（每张带纯色色块区与细节区）：

1. ICC v4 Display P3 JPEG（含 sRGB 外的饱和红绿）；同图 ICC v2 版本；Adobe RGB JPEG。期望：缩略图色块 ΔE2000 < 1（阈值待定）；在默认 sRGB canvas 中观察到裁切即证实 1.3 的推论。
2. LUT 型（A2B0／A2B1 不同）ICC v4 RGB 图，检验 moxcms 与 Chromium 选用的标签和渲染意图是否一致。
3. CMYK JPEG：带 FOGRA39 等 CMYK 配置文件一张、无配置文件一张、Adobe 反相标记一张。
4. PNG 色彩块组合：仅 gAMA（0.45455 与 1/1.8）；gAMA＋cHRM（P3 原色）；sRGB 块＋矛盾的 gAMA；iCCP＋cICP 同时存在；仅 cICP（Display P3、BT.2020 PQ）。期望与 Skia 优先级一致。
5. 16 位 PNG 平滑渐变（灰与饱和色），检查 8 位缩略图与原图显示的色带。
6. 细线与网点：白底 1 px 黑线、1 px 彩色线、棋盘格、动漫线稿局部；缩小到 1/3、1/7.5；比较 Lanczos3／Mitchell、线性光／编码值、`createImageBitmap high`、libvips。由画师对照优动漫的缩小显示判断，确定默认管线。
7. 透明边：半透明发丝、抗锯齿边缘的 PNG 与 WebP，铺在白、黑、灰底上检查暗边或彩边。
8. EXIF 方向 1–8：JPEG、带 eXIf 的 PNG、带 EXIF 的 WebP；原图显示、缩略图与钉图坐标三者一致。
9. 画师真实图库抽样：缩略图体积（无损 WebP vs PNG）、生成耗时、内存峰值，与 libvips 对照；同时测 `moxcms` vs `lcms2` 在同一样本上的差异。
10. 显示器状态矩阵：普通 SDR 无 ICC／有校准 ICC、Windows 自动色彩管理、HDR 开启；每种状态测实验 1 的显示效果，以及 #5734 的偏黄是否出现、`--force-color-profile=srgb` 是否有效。
11. 截图恒等：在每种显示器状态下，截取含饱和色与灰阶的屏幕区域，钉图后再截取钉图本身，逐像素比较；HDR 状态分别测 8 位与 FP16 采集。
12. 钉图：100%／125%／150%／175% 缩放下，canvas `display-p3` 与 `<img>` 两种实现的像素对齐和色差；WebGPU 在开发机与画师电脑上是否可用。
13. 增益图 JPEG 与 PQ AVIF：在 HDR 显示器上 `<img>` 是否以 HDR 显示，SDR 显示器上的基础图是否与缩略图一致。

另外未核实：skcms 对全部 ICC v4 标签的支持；Chromium `<img>` 缩小时实际使用的滤镜；`png` crate 写 cICP 与 zune-jpeg 输出原始 CMYK 的 API；moxcms 与 skcms、lcms2 的数值差异；各方案的二进制体积增量；WebView2 154 中 float16 canvas 是否可用；Windows 兼容助手是否作用于 WebView2 子进程。
