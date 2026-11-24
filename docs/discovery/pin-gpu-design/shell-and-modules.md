# 原生钉图 GPU 方案：平台壳、模块划分与颜色

[总览](../pin-gpu-design.md)

## 3. 平台壳：接口与 Windows 实现

### 接口

```rust
/// 每张钉图一个平台窗口组。实现保证：同一时刻只有一个槽看得见；看得见的槽只平移；
/// swap 之前的 stage＋渲染层 Present 在 swap 返回后与可见性切换同一帧生效。
pub trait PinShell {
    /// 新建一张钉图的两个槽，返回给渲染层建 Surface 用的目标。
    fn create(&mut self, pin: PinId) -> [wgpu::SurfaceTargetUnsafe; 2];
    /// 第一次显示（含提交）。
    fn show(&mut self, pin: PinId, rect: ScreenRect);
    /// 平移看得见的槽（尺寸不变）。
    fn translate(&mut self, pin: PinId, rect: ScreenRect);
    /// 把备用槽摆到 rect、保持看不见；之后渲染层往备用槽 Present。
    fn stage(&mut self, pin: PinId, rect: ScreenRect);
    /// 等备用槽被合成器收下，一次提交换上来。
    fn swap(&mut self, pin: PinId);
    fn visible_slot(&self, pin: PinId) -> usize;
    fn set_click_through(&mut self, pin: PinId, on: bool);
    /// 处理窗口消息，取出输入（屏幕物理像素，与 DPI 无关）。
    fn pump(&mut self) -> Vec<PinInput>;
    fn close(&mut self, pin: PinId);
}
```

原型里还有一个 `housekeeping`（过两个刷新周期隐藏换下的槽）。正式方案放进 `pump`，调用方不用知道。

接口里只有矩形、可见性和输入，不出现 DPI、颜色、图片。Wayland 单窗口的实现里，`stage` 只记下矩形，`swap` 是空的，渲染层 Present 时就 commit。

### Windows 实现：每一条怎么满足

| 要求 | 做法 | 状态 |
|---|---|---|
| 不抢焦点 | `WS_EX_NOACTIVATE`，`WM_MOUSEACTIVATE` 返回 `MA_NOACTIVATE`，`SetWindowPos` 都带 `SWP_NOACTIVATE` | 实测：前台为别的程序时 SendInput 拖动 60 px、滚轮 3 格（期间换窗 2 次），前台都没变 |
| 不进任务栏、Alt+Tab | `WS_EX_TOOLWINDOW` | — |
| 置顶 | `WS_EX_TOPMOST`；备用槽插在可见槽紧下面 | — |
| 点击穿透 | 切 `WS_EX_LAYERED | WS_EX_TRANSPARENT`；不影响 DComp 内容 | 实测：穿透后光标下的窗口变成后面的程序，关掉后再画一帧正常 |
| 透明处点到别的程序 | 窗口只有钉图＋阴影一圈大，阴影算钉图的一部分（与现在一致） | 实测：阴影最外一列命中钉图，窗口外一列不命中。**手势中**的包络窗口比钉图大，最长 120 ms 内包络里的空白处也会接住点击，见风险 |
| 全屏判定（ADR 0011） | `plan` 的 `clip` 是显示器让出最下面一行 | 实测：钉图盖满屏幕时让出一行不报，不让出（`--full-screen-ok`）报 `QUNS_BUSY` |
| 不让 Chromium 判为遮挡（#275） | 窗口只有钉图大；`WS_EX_TOOLWINDOW` | 实测：背后最大化 Edge 在 1 张、8 张、盖满屏幕（让出或不让出）、缩放换窗中都 `visible`、约 171 rAF/s |
| 键盘 | 窗口不激活就收不到键。沿用前一个原型的结论：低级键盘钩子按光标位置判断是否给钉图（R、T、C、[、] 等），菜单仍用 WebView 窗口 | 本原型没有再测 |
| 多显示器、DPI | 进程设 Per-Monitor V2；接口全用屏幕物理像素，窗口一律 `SetWindowPos` 物理矩形；钉图跨显示器时 `clip` 换成那台显示器的 | 本机只有一台显示器，**没有测**跨显示器拖动与 `WM_DPICHANGED` |

### 与 Tauri 的关系

钉图窗口不经 tao 建：tao 的窗口带它自己的样式、`WM_NCCALCSIZE` 处理和重定向位图，DComp 目标要的是 `WS_EX_NOREDIRECTIONBITMAP`。平台壳在 Tauri 的主线程上自己 `CreateWindowExW`（`run_on_main_thread`）。tao 的消息循环会分发本线程所有窗口的消息，所以我们的窗口过程照常被调用，不需要第二个消息循环。渲染（wgpu 设备、编码、Present）可以放在另一个线程，只有 `stage`、`swap`、`translate` 要在主线程上调（或用 `SetWindowPos` 的跨线程语义，到时再定）。

## 4. 模块划分

按 codebase-design 的说法：每个模块是一个窄接口后面藏一大块行为；平台差异只出现在一个接缝（seam）上，那里有 Windows 和测试替身两个适配器，以后再加 macOS、Wayland。

```
kinshoko-core::desktop::frame      纯函数：钉图几何与“这一帧怎么上屏”
        ▲
pin-render（新 crate，跨平台）      wgpu：上传、mip、着色器、颜色 LUT
        ▲
pin-shell（trait＋各平台适配器）     窗口、输入、一次提交换上来
        ▲
src-tauri desktop（编排）          把 PinStore、输入、渲染、平台壳接起来
```

| 模块 | 接口（调用方要知道的全部） | 藏在后面的 | 测法 |
|---|---|---|---|
| `kinshoko-core::desktop::frame`（新） | `View`（源尺寸、位置、缩放、旋转翻转、裁切、透明度）的 `zoom_at`、`rotate_cw`、`content`；`plan(window, drawn, content, clip, gesture) -> Step`；`needed`、`envelope` | 缩放锚点不漂移、绕中心旋转、取整规则、包络大小、什么时候换窗；贴边吸附、贴边隐藏继续用已有的 `EdgeHide`、`pull_onto_screen`，`clip` 用已有的 `overlay_window` | 单元测试（原型 8 个：锚点、旋转中心、停手贴合、拖动只挪、拖出屏幕、放大一次换窗后都重画、比屏幕大、包络不出显示器） |
| `pin-render`（新 crate） | `Renderer::new()`；`upload(pixels, colour) -> Image`；`unsafe surface(target) -> Surface`；`draw(&mut Surface, &Image, window, &View, &DisplayColour)` | wgpu 设备与显存策略、mip 生成、WGSL（采样、旋转翻转、裁切、CSS 同款阴影、透明度、预乘）、颜色 LUT、输出格式（SDR 8 位／scRGB） | 离屏渲染到纹理读回，和 `render_sdr` 派生图逐像素比（前一个原型的 `--compare` 做法） |
| `pin-shell` | 上面的 `PinShell` trait；`PinInput` | 每个平台的窗口样式、焦点、穿透、DComp／CA／Wayland 提交、指针捕获交接、换下的槽什么时候隐藏 | 适配器：Windows（真）、记录调用顺序的假实现（编排层的测试用）；0 错位只能在真机上用逐帧核对测 |
| 编排（`src-tauri/src/desktop`） | 现有 Tauri 命令与 `PinStore` | 输入 → `View` 变化 → `plan` → 平台壳与渲染层；停手计时；从 `Library` 取派生图 | 用假平台壳测“滚轮一格 → 一次 Swap 后都是 Redraw”等 |

`plan` 放在 core 而不是平台壳里，是因为它决定的是“该不该改尺寸”，与平台无关。Wayland 单窗口时 Swap 也照样有意义，就是改尺寸那一帧。

## 5. 颜色（设计，没有实测）

原型只做了 sRGB：源图按 `Rgba8UnormSrgb` 采样（线性光插值），输出手工 sRGB 编码。正式方案：

1. **源**：钉图只显示 Rust 生成的派生图（ADR 0005 的 `fit-<像素>`，按显示尺寸选档），不再上传 24 MP 原图。放大超过派生图时换更大的一档；1:1 以上直接用原图。
2. **上传**：moxcms 把派生图从它的色彩声明转到线性工作空间（线性 scRGB，`Rgba16Float`），这样 GPU 的双线性和三线性插值都在线性光下。代价是每像素 8 字节；按显示尺寸上传时，1000×1500 的钉图约 12 MB 显存。
3. **输出**：着色器最后一步查一张 3D LUT（moxcms 由“线性工作空间 → 显示器配置文件”生成，例如 33³，`Rgba16Float`），输出 8 位显示器编码。钉图拖到配置文件不同的显示器上只换 LUT，不用重新上传。ACM 或 HDR 下输出改成 scRGB `Rgba16Float` 交换链，LUT 换成恒等或色调映射。
4. **验收**：与 WebView2 显示同一派生图做 ΔE 对照，纳入现有门槛实验（`fidelity_gate`）。

这改变了 ADR 0005 “到屏幕的颜色转换只有 WebView2 一处”：钉图的颜色转换移到 Rust（moxcms）和着色器。要写新 ADR（第 9 节）。
