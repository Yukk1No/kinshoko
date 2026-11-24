# 原生钉图 GPU 方案：GPU 层选型

[总览](../pin-gpu-design.md)

## 1. GPU 层选型

| | wgpu 30 | skia-safe（Graphite／Ganesh） | 各平台原生 API（D3D11/DComp、Metal、Vulkan） |
|---|---|---|---|
| 成熟度 | Firefox 的 WebGPU、Bevy 等都建在它上面；每 12 周一个大版本，API 会破坏性变化 | Chromium 本身的绘图库，最成熟；Rust 绑定靠预编译二进制 | 最成熟，但每个平台写一遍 |
| 接 Tauri／tao | 吃 `raw-window-handle` 0.6 或 `SurfaceTargetUnsafe`。钉图窗口由平台层自己建，不经 tao（见第 3 节） | 要自己从 GPU 上下文建 Surface，每个平台一套胶水 | 不经抽象 |
| 逐像素透明 | Windows：只有 **DComp visual** 目标给 `PreMultiplied`；HWND 目标只有 `Opaque`，Vulkan 后端在 Windows 也只有 `Opaque`。所以 Windows 用 DX12＋`CompositionVisual`。macOS（Metal 层）、Wayland（Vulkan）都有预乘 | 同 wgpu 底层的限制 | 同左 |
| 颜色、HDR | 输出格式与色彩空间可选：`Bgra8Unorm`（SDR）、`Rgba16Float`＋扩展线性 sRGB（scRGB，ACM 与 HDR）、`Rgb10a2`＋BT.2100 PQ。颜色转换由我们在着色器里做（moxcms 生成 3D LUT） | 自带 skcms，与 Chromium 同源，最容易对齐 ADR 0005 的颜色 | 同 wgpu，但要写三遍 |
| 体积 | 整个原型 exe 6.1 MB（含 wgpu、naga、image、windows），不带额外 DLL（DX12 着色器用系统自带的 FXC） | 预编译 Skia 约 20～30 MB | 最小 |
| 显存 | 设备基线 52 MB（`MemoryHints::MemoryUsage`；默认的 `Performance` 是 172 MB） | 相近 | 最小 |

**选 wgpu。** 它是唯一同时满足这几条的：一套着色器在三个平台跑；透明、HDR 的出口都在；平台差异只剩“给它一个 Surface 目标”。skia 的长处是颜色与 Chromium 同源，但钉图以后只显示 Rust 生成的派生图（第 4 节），不需要 Chromium 的颜色解释。它的体积和预编译依赖也不划算。

wgpu 的已知坑（原型里踩到的）：

- 交换链挂到 DComp visual（`SetContent`）以后，wgpu **不提交**，提交要我们自己调。第一次显示时忘了提交，窗口就一直是空的。
- 默认的显存分配块很大（`Performance`：私有 314 MB、显存 172 MB），要用 `MemoryUsage`。
- 每 12 周一个大版本。正式方案把 wgpu 只放在渲染模块里（第 4 节），升级只改这一个模块。
