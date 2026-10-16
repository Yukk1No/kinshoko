# 原图交给 WebView2 解释颜色，缩小由 Rust 生成派生图

管线以还原度为最高优先级，并要为 HDR 留路。画师看到的每个像素只来自两条路：原图在 1:1 和放大时由 WebView2 直接解释并转换到显示器；缩略图和“适应窗口”等缩小显示由 Rust 生成派生图，按与 Chromium 相同的色彩声明规则解释（`moxcms`），在 f32 下做预乘 alpha 缩放（`fast_image_resize`），以无损格式保存并按设备像素 1:1 交给 WebView2。这样到屏幕的颜色转换只有 WebView2 一处，缩放只有 Rust 一处，两者分别验收、分别升级。依据见[图片还原度管线核查](../research/image-fidelity-pipeline.md)。

## Considered Options

- **全部交给 WebView2**（含 `createImageBitmap` 缩小）：只有一套色彩管理，但 Chromium 的缩小是单次 Catmull-Rom，大倍率缩小会混叠，也不在线性光下运算。
- **libvips**：能力完整，但要部署 DLL、LGPL；保留为备选。
- **Windows WIC**：与 Chromium 不同源，行为随系统变化。

## Consequences

- WebView2 自己解码的结果是派生图颜色的验收基准；两套色彩管理（moxcms 与 Chromium 的 skcms）的残差由门槛实验量化。
- 原图永不改写；导入时记录色彩描述（ICC、cICP、位深、CMYK、HDR 与增益图标记）；派生图缓存键含管线版本和 `sdr`／`hdr` 变体。HDR 显示时把钉图渲染器换成 WebGPU，不改存储。
- 直接显示只用于静态 SDR、且色彩声明能被 Chromium 精确表示的原图。导入时标为动图（GIF、动态 WebP、APNG）或 HDR（增益图、PQ/HLG）的原图，在 1:1 和放大时也显示 Rust 生成的 `sdr` 派生图（动图取首帧），否则 WebView2 会播放动图、在 HDR 显示器上按 HDR 渲染，与缩略图和钉图不一致。动图播放和 HDR 显示上线时再为这两类开放直接显示或 `hdr` 变体。
- 生效的 ICC 是查找表型（Chromium 不能精确表示：没有可用的 rXYZ/gXYZ/bXYZ 矩阵＋曲线，或带 A2B0／A2B1）以及全部 CMYK／YCCK 配置文件的原图，同样只显示原尺寸 `sdr` 派生图。原因（#45 门槛实验实测）：Chromium 对这类配置文件建不出精确的色彩空间，在解码时转换到近似空间，没有矩阵时就是 sRGB，广色域被裁掉（`skia/ext/color_profile.cc` 的 `ComputeSkColorSpace`）；skcms 读 lut16 时，XYZ PCS 没有乘 u1Fixed15 系数（`read_tag_mft2`，按 0.5 倍线性亮度显示），Lab PCS 按 v4 编码读旧式编码（`lab_to_xyz`）。派生图按 ICC 规范解释，不跟随 skcms。判断在导入时由色彩描述做出（`ColourDescription::needs_sdr_derivative`），看图界面经 `Library::display`（`thumb` 协议的 `<资料库 id>/<参考图 id>/full`）取图。WebView2 更新后用门槛实验复查。
- WebView2 是常青运行时，颜色行为可能随更新变化：保留一个需重启生效的“强制 sRGB”诊断开关，并在大版本更新后复测。
