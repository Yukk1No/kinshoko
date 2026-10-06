# 原图交给 WebView2 解释颜色，缩小由 Rust 生成派生图

管线以还原度为最高优先级，并要为 HDR 留路。画师看到的每个像素只来自两条路：原图在 1:1 和放大时由 WebView2 直接解释并转换到显示器；缩略图和“适应窗口”等缩小显示由 Rust 生成派生图，按与 Chromium 相同的色彩声明规则解释（`moxcms`），在 f32 下做预乘 alpha 缩放（`fast_image_resize`），以无损格式保存并按设备像素 1:1 交给 WebView2。这样到屏幕的颜色转换只有 WebView2 一处，缩放只有 Rust 一处，两者分别验收、分别升级。依据见[图片还原度管线核查](../research/image-fidelity-pipeline.md)。

## Considered Options

- **全部交给 WebView2**（含 `createImageBitmap` 缩小）：只有一套色彩管理，但 Chromium 的缩小是单次 Catmull-Rom，大倍率缩小会混叠，也不在线性光下运算。
- **libvips**：能力完整，但要部署 DLL、LGPL；保留为备选。
- **Windows WIC**：与 Chromium 不同源，行为随系统变化。

## Consequences

- WebView2 自己解码的结果是派生图颜色的验收基准；两套色彩管理（moxcms 与 Chromium 的 skcms）的残差由门槛实验量化。
- 原图永不改写；导入时记录色彩描述（ICC、cICP、位深、CMYK、HDR 与增益图标记）；派生图缓存键含管线版本和 `sdr`／`hdr` 变体。HDR 显示时把钉图渲染器换成 WebGPU，不改存储。
- 直接显示只用于静态 SDR 原图。导入时标为动图（GIF、动态 WebP、APNG）或 HDR（增益图、PQ/HLG）的原图，在 1:1 和放大时也显示 Rust 生成的 `sdr` 派生图（动图取首帧），否则 WebView2 会播放动图、在 HDR 显示器上按 HDR 渲染，与缩略图和钉图不一致。动图播放和 HDR 显示上线时再为这两类开放直接显示或 `hdr` 变体。
- WebView2 是常青运行时，颜色行为可能随更新变化：保留一个需重启生效的“强制 sRGB”诊断开关，并在大版本更新后复测。
