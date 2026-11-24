# 桌面钉图每张一个原生窗口，用 wgpu 画；看得见的窗口只平移，改尺寸在备用窗口上做好再换上

#193 把钉图放进“每台显示器一个铺满的透明置顶 WebView2 钉图层”，解决了 WebView2 改窗口尺寸时的抽搐和闪烁，却让钉图层成了“铺满显示器的置顶窗口”，被系统和别的程序特殊对待：全屏判定（ADR 0011 靠让出一行躲开），以及 [#275](https://github.com/Yukk1No/kinshoko/issues/275)：背后的程序最大化时，Chromium 的遮挡判定把钉图层算成挡住了整个工作区，Edge、Electron 程序和 Kinshoko 主窗口停止绘制。维护者决定不再修补钉图层。

决定：**每张钉图一个原生窗口，窗口只有钉图（含阴影一圈）那么大，不用 WebView 画，用 wgpu（WGSL 着色器）在 GPU 上画。** 缩放、旋转翻转、裁切、透明度、阴影、遮蔽和增强边缘都在 GPU 上做。“画面与窗口几何同一帧到位”靠一条规则保证：**看得见的窗口只平移、不改尺寸；尺寸要变时，在看不见的备用窗口上摆好、画好，等合成器收下，再用一次合成器提交把它换成看得见的。** 每张钉图因此有两个窗口槽。手势进行中换上来的是包络（需要的矩形放大到两倍、夹在显示器里），之后两倍以内的放大和任意缩小都只重画；停手后再换一次，收成刚好盖住钉图。每一帧走哪条路（重画、平移、换窗、不显示）由 `kinshoko-core` 里的纯函数决定，与平台无关。

依据：[跨平台 GPU 方案调研](../discovery/pin-gpu-design.md)，原型在 [`prototype/pin-gpu-wgpu`](https://github.com/Yukk1No/kinshoko/tree/prototype/pin-gpu-wgpu/tools/pin-gpu-probe) 分支。Windows 上用 DXGI 桌面复制逐帧核对两轮约 3 000 帧，0 帧错位；同一把尺子量“一个窗口每帧改尺寸再 Present”，每轮 11～65 帧错位。背后最大化的 Edge 在 1 张、8 张、盖满屏幕和缩放换窗中都保持 visible、约 171 rAF/s。重画每帧 CPU 约 0.5 ms、GPU ≤ 0.7 ms，与窗口大小无关。

平台代码只在一层窄接口 `PinShell` 后面：建两个槽、显示、平移、摆备用槽、换上、点击穿透、取输入、关闭。接口里只有屏幕物理像素的矩形、可见性和输入，没有 DPI、颜色、图片。渲染层只认 wgpu 的 Surface 目标，不出现平台类型。Windows 的实现是两个 `WS_EX_NOREDIRECTIONBITMAP` 窗口挂在同一个 DirectComposition 设备上，换上是一次 `Commit` 里同时改两个 visual 的不透明度。macOS（两个 `NSPanel` 在一个 `CATransaction` 里换）和 Wayland（单窗口，surface commit 本身是原子的，换上退化为“改好状态再 Present”）按同一接口实现，都在 v1 之后，手段是推断，没有实测。

## Considered Options

- **继续修补钉图层**（加 `WS_EX_TOOLWINDOW` 等）：能躲开这一次的遮挡判定，但样式会被 tao 重写冲掉（#276 实测），而且“铺满显示器的置顶窗口”这一类问题补了一个还会冒出下一个（#225、#229、#230、#275）。根子在窗口形状，不在样式。
- **每张钉图一个 WebView2 窗口**：#193 时已否决，WebView2 改窗口尺寸本身就会抽搐闪烁，每张还多约 100 MB 显存。
- **Win32 `UpdateLayeredWindow`（ULW）**：一次调用同时交出几何和像素，逐帧核对也是 0 错位（[ULW 原型](../discovery/native-pin-prototype.md)，分支 [`prototype/native-pin-ulw`](https://github.com/Yukk1No/kinshoko/tree/prototype/native-pin-ulw/tools/native-pin-probe)）。否决：像素必须在 CPU 上，铺满 1440p 时每帧约 12 ms、170 Hz 下掉到约 85 fps；每张大图常驻约 124 MB 内存；只能交 8 位 sRGB，HDR 没有路；绘制绑死在 Windows API 上，与将来跨平台的目标冲突。
- **单个 DirectComposition 窗口，每帧改尺寸再 Present**：GPU 绘制，但窗口几何（`SetWindowPos`）与交换链内容是两件事，合成器不保证同一帧生效，实测约 4% 的帧错位，与用不用 wgpu 无关。
- **skia（skia-safe）**：颜色与 Chromium 同源，但钉图以后只显示 Rust 生成的派生图（ADR 0014），用不上这一点；预编译二进制约 20～30 MB，每个平台要自己写 GPU 上下文的胶水。wgpu 一套着色器跑三个平台，透明和 HDR 的出口都有，原型 exe 共 6.1 MB。
- **每个平台直接用原生图形 API**（D3D11/DComp、Metal、Vulkan）：最成熟、最小，但绘制要写三遍，违背“绘制不绑某一个平台”。

## Consequences

- 钉图层整个删除：`pins/layers.rs`、`PinLayer.tsx`、`PinView.tsx`、`renderer.ts`、`pinKeys.ts`、`pin-edge.css`，以及 core 里只为钉图层服务的 `layer_window`、`layer_region`、`layers_for`、`widen`。钉图菜单（#106）和截图框选仍是 WebView 窗口，仍按 ADR 0011 经 `overlay_window` 取矩形。
- ADR 0011 照样适用：钉图放大到盖满一台显示器时，窗口也裁成让出最下面一行，否则报 `QUNS_BUSY`（原型实测）。
- 钉图窗口不激活，拿不到键盘焦点。钉图的快捷键改由低级键盘钩子按光标位置判断：光标在某张钉图（含阴影）上才拦，其余放行；以前“光标不在钉图上时作用在最近按过的那张”的规则随之取消，因为那时按键会进绘画软件。钩子的回调不能被卡住，读图、上传、换窗等待都不能放在钩子所在的线程。
- 进程常驻一个 GPU 设备：约 130 MB 私有内存、52 MB 显存，与钉图数量无关；没有钉图时可以释放。每张钉图按显示尺寸上传派生图，常见尺寸约十几 MB 显存（推断，实现时实测）。
- 换窗一次 8～11 ms，其中 4～6 ms 是等合成器收下备用窗口，每次手势一般 1～2 次。等待必须异步（DWM 帧统计或 DComp 帧 id），不能在界面线程上 `DwmFlush`。
- 手势中（到停手后 120 ms）包络窗口里钉图外的透明处也会接住点击。实现时用窗口区域只裁输入，或接受这段时间。
- wgpu 每 12 周一个大版本，只有 `pin-render` 依赖它，升级只改这一个模块。GPU 设备丢失（驱动更新、远程桌面切换）时渲染层整个重建、重新上传。
- 钉图的显示器颜色转换不再由 WebView2 做，见 ADR 0014。
