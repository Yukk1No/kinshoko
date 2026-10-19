# 图片管线：复用边界与首版提案

核验：2026-10-03（Asia/Shanghai），供[核查竞品技术栈与首个功能的可复用依赖](https://github.com/Yukk1No/kinshoko/issues/12)评审。仅读官方源码／文档；**未构建、运行、安装或测性能，以下门槛全部未验证**。承接[候选调查](anime-library-research.md)、[存储实践](library-storage-practices.md)和[Tauri 评估](tauri-fit-evaluation.md)，遵循最新词汇表及 Eagle、独立参考组 ADR。

**建议（推论）：优先验证 Tauri 2＋WebView2 原图显示；颜色／alpha样本通过后，Rust `image` 才作为缩略图基线。** 首切片是资料库创建／打开、静态图片导入、图库与原图查看、关闭后重开。编解码、缩放和渲染均复用；应用只写资料库状态、任务调度和失败恢复。以下三个产品借鉴实践，不能作为可直接嵌入的 Rust 包。

| 对照／可复用依赖 | 固定证据与边界 | 取舍 |
|---|---|---|
| Monbooru v1.22.0／`f49d97e4` | 普通图片双线性缩小，长边300px、JPEG质量85；超大图另产查看副本。[源码][M] | 借鉴派生图分离；固定300px不足以保证高DPI清晰，查看副本也不等于原图 |
| Curator／`f98f0b5c` | `image→RGB→FIR→WebP75`、按宽度缓存；可见图停止滚动后切原图。[解码][C1]、[缩略图][C2]、[显示][C3] | 借鉴按需原图与缓存；RGB路径丢alpha，不照搬 |
| Hydrus v688／`e1cbffc2` | EXIF转正，Pillow ImageCms转换到sRGB；缩略图边界乘`thumbnail_dpr_percent`，透明图用PNG。[图片][H1]、[色彩][H2] | 借鉴方向／颜色／DPI各自处理；Python、Pillow、OpenCV整套不引入Rust首版 |
| `image 0.25.10` | MIT／Apache-2.0，Rust≥1.88；已有解码、方向和resize。默认启用多格式／rayon。[manifest][I0] | 基线复用，关默认，仅启用`jpeg,png,webp`，锁定Cargo.lock |
| `fast_image_resize 6.1.0` | SIMD缩放及alpha MulDiv；不会自动线性化色彩。[官方][F] | 首版不加；仅缩放瓶颈或透明边缘失败证明需要时评估 |
| libvips 8.18.0 | thumbnail整合加载／缩放／alpha，ICC转换依赖lcms2构建；Windows有原生发行包，LGPL-2.1-or-later。[源码][V1]、[构建说明][V2] | ICC／大图替代候选；新增动态库、架构、绑定与许可核对成本 |

导入先检查格式、尺寸和错误，再复制原始字节并校验SHA-256；**原图不重编码**，已有EXIF／ICC／XMP随字节保留，不代表已解析成全部参考图元数据。首版白名单是静态JPEG／PNG／WebP，动画与其他格式明确报不支持。有界后台队列生成缩略图；尺寸取图库实际CSS尺寸×DPR，按档缓存且不放大小原图。缓存键含原图哈希、目标像素和管线版本；删缓存、重开可重建。以上是提案，不是已完成实现。

缩略图通过decoder读取方向，再`apply_orientation`一次；尺寸及后续参考组成员裁切统一使用转正后的坐标。派生图不再携带旧方向；原图由WebView按`from-image`显示，前端不再次旋转。方向API存在仍须验证1–8的旋转／镜像及PNG／WebP支持。[Rust方向][I1]、[CSS方向][W1]

**ICC提取／编码器写回不等于像素色彩转换。** `image`的CICP接口也不证明支持任意ICC；普通resize在编码值上运算，高层写图不会自动保留ICC／CICP。基线Rust缩略图只放行已验证的sRGB／无标记普通RGB；ICC、非sRGB及不能确认的颜色声明不能默默去profile生成异色缓存。**颜色／alpha是第一功能实现前的依赖选型门槛**：先核验广色域、灰阶／CMYK和PNG颜色声明；不通过就转评估libvips＋lcms2的Windows部署与适配。透明图保留PNG／alpha，重采样不能靠转JPEG掩盖。单文件失败可占位提示，但不能长期以占位绕过画师的颜色要求。[解码元数据][I2]、[高层色彩限制][I3]

原图用`convertFileSrc`交给`<img>`，asset scope仅授权当前资料库及缓存，CSP允许对应origin；避免base64整图IPC。固定Tauri v2.8.5源码仍有读取到缓冲的路径，因此asset不是零复制／大图免解码。Web色彩规范支持图像色彩管理的方向，不能替当前WebView2、显示器ICC的实测背书；**原图首次颜色正确与缩略图颜色一致分别验收**。[asset配置][T1]、[固定源码][T2]、[色彩规范][W2]

坏图、截断和超尺寸应逐文件报错／保留可重试状态，不挂死导入。先查尺寸、限制并发与像素预算，再设`Limits`；其宽高限制是严格限制，`max_alloc`是尽力而为，不能当总进程内存上限，更不会限制WebView2解码。[限制][I4]

生产承诺前在无独显Windows验：EXIF1–8、小图细线／像素网格、透明边缘、ICC原图与缩略图分别对照绘画软件；100／125／150／200%及混合DPI下物理像素1:1；分页滚动、冷／热首次清晰时间、Core＋WebView2内存峰值、损坏／超大图、取消和缓存释放。记录版本、样本哈希及机器；具体预算与画师确认后成为门槛。清晰查看是正确读取与映射原像素，不是AI放大。离线安装另计WebView2 Runtime，干净标准用户机器验证。[部署][T3]

裁切／钉图／参考组以后复用原图身份和转正坐标，保留独立成员状态；标签、Eagle导入与备份另接领域边界。本切片不加模型运行时：ONNX／PixAI以后负责输入预处理、推理与建议来源，绝不替代原图显示或改变原字节；不重做模型排名。[既有接入研究](tagger-integration.md)

若颜色门槛失败而选择浏览器直接读原图作为有限降级，必须同时限制可见图数量、原图像素及并发，实测内存和响应后公开支持范围；不能让整页原图加载替代真正的缩略图管线。缓存只是显示派生物，不能作为备份／迁出包里的原图或整理信息来源。样本不足就保留未决，既不编造色彩转换，也不自行补编码器、插值算法或渲染器。

本报告的版本是可查基线，不声称最新或已经兼容：锁定Tauri／image及传递依赖、Rust工具链，记录WebView2 Runtime与显示器设置，再做最小样本验收；image版本、颜色策略或缩放器变化时更新管线版本并使旧缓存失效。Windows安装另核架构、实际DLL清单与离线首次启动，依赖声明不能代替可复现安装包；库关闭／重开还要验证原图字节哈希、元数据与错误状态恢复。

[M]: https://github.com/monbooru/monbooru/blob/f49d97e45de899e4413bc5239c4efe3e799fdf2d/internal/gallery/thumbnail.go
[C1]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-media/src/decode.rs
[C2]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-media/src/thumbnail.rs
[C3]: https://github.com/FuouM/Project-Curator/blob/f98f0b5c1941185ba781cb51963fefe023d42c42/curator-dashboard/src/cards.ts
[H1]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/core/files/images/HydrusImageHandling.py
[H2]: https://github.com/hydrusnetwork/hydrus/blob/e1cbffc2f7d4a64a44cc25345718cde363ef6221/hydrus/core/files/images/HydrusImageNormalisation.py
[I0]: https://github.com/image-rs/image/blob/v0.25.10/Cargo.toml
[I1]: https://docs.rs/image/0.25.10/image/enum.DynamicImage.html#method.apply_orientation
[I2]: https://docs.rs/image/0.25.10/image/trait.ImageDecoder.html
[I3]: https://docs.rs/image/0.25.10/image/enum.DynamicImage.html#color-space
[I4]: https://docs.rs/image/0.25.10/image/struct.Limits.html
[F]: https://docs.rs/fast_image_resize/6.1.0/fast_image_resize/
[V1]: https://github.com/libvips/libvips/blob/v8.18.0/libvips/resample/thumbnail.c
[V2]: https://github.com/libvips/libvips/blob/v8.18.0/README.md
[T1]: https://v2.tauri.app/reference/javascript/api/namespacecore/#convertfilesrc
[T2]: https://github.com/tauri-apps/tauri/blob/80eadb7387459639037e3a279c61c9631b1dafe7/crates/tauri/src/protocol/asset.rs
[T3]: https://v2.tauri.app/distribute/windows-installer/
[W1]: https://www.w3.org/TR/css-images-3/#the-image-orientation
[W2]: https://www.w3.org/TR/css-color-4/#untagged
