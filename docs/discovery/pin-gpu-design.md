# 原生钉图：跨平台 GPU 绘制方案

问题（[#277](https://github.com/Yukk1No/kinshoko/issues/277)）：桌面钉图从“每台显示器一个铺满的 WebView2 层”（#193）改成“每张钉图一个原生小窗口”。前一个原型（[ULW 原型](native-pin-prototype.md)）用 `UpdateLayeredWindow`（ULW）在 CPU 上缩放，做到了 0 帧错位，但铺满屏幕时每帧约 12 ms，而且渲染绑死在 Windows API 上。这里在不沿用它结论的前提下重新回答：渲染能不能走跨平台 GPU 抽象，同时守住 0 帧错位；平台代码能薄到什么程度；模块怎么切。

原型在 [`prototype/pin-gpu-wgpu`](https://github.com/Yukk1No/kinshoko/tree/prototype/pin-gpu-wgpu/tools/pin-gpu-probe) 分支的 `tools/pin-gpu-probe/`（丢弃型，不进 `integration/v1`），用法见那里的 README。

> 本方案已选定，决定见 [ADR-0013](../adr/0013-native-pin-windows-wgpu.md) 与 [ADR-0014](../adr/0014-pin-colour-in-rust.md)，正式规格见 [#277](https://github.com/Yukk1No/kinshoko/issues/277)。

## 结论

**可行。用 wgpu（WGSL）画，每张钉图两个原生窗口槽。规则是“看得见的窗口只许平移，尺寸变化在看不见的备用窗口上做好，再一次合成器提交换上来”。** Windows 上实测两轮各约 1 500 帧逐帧核对，**0 帧错位**；同一把尺子量“一个窗口每帧改尺寸＋Present”的对照组，每轮 11～65 帧错位。

- 每帧耗时与窗口大小基本无关：重画中位约 0.5 ms，GPU 完成 ≤ 0.7 ms，铺满屏幕也一样。ULW 在铺满屏幕时要 12 ms。
- 换窗口（只在手势开始、手势里放大超过约 2 倍、停手收窗口、旋转时发生）一次 8～11 ms，其中约 4～6 ms 在等合成器收下备用窗口。每次手势一般 1～2 次。
- 背后最大化的 Edge 在所有场景都 `visible`，约 171 rAF/s（#275 不再出现）。全屏判定照 ADR 0011 让出一行就不报 `QUNS_BUSY`。拖动、滚轮不抢前台。
- 代价是常驻 GPU 设备：进程多约 130 MB 私有内存、52 MB 显存，与钉图数量无关。原图整张上传时，每张 24 MP 钉图另占约 125 MB 显存。正式方案改为按显示尺寸上传，常见钉图只需几 MB（推断，见“代价”）。
- 平台代码只有窗口、输入、那一次提交这一层（原型约 350 行，是唯一的 `unsafe` 平台代码）。几何和“这一帧怎么上屏”是纯函数，渲染层只认 `wgpu::SurfaceTargetUnsafe`。macOS 与 Linux 的接口相同；它们的 0 错位手段是推断，没有实测。

## 测试环境

Windows 11 Pro 26300，RTX 4070 SUPER（DX12），显示器 2560×1440、170 Hz（刷新周期 5.88 ms）、DPI 106，开着自动色彩管理。wgpu 30.0.1，release 构建。测试图 `marker.png`：4000×6000，品红边框宽为短边 5%，内部绿棋盘，由原型生成。

测 Edge 时要注意：全新配置目录启动的 Edge 会自动用系统账户登录、同步、装扩展，扩展再自己开一个“Getting Started”标签页，测试页因此被判为 `hidden`。第一次测时误以为是钉图的问题，查明后改为 `--disable-extensions --disable-sync` 启动。下面的数据都是改了以后测的。

## 分篇

- [1. GPU 层选型](pin-gpu-design/gpu-layer.md)：wgpu、skia、各平台原生 API 的比较，wgpu 的坑。
- [2. 0 错位：怎么做到](pin-gpu-design/zero-mismatch.md)：问题在哪、规则、Windows 实测、macOS 与 Linux 的推断。
- [3～5. 平台壳、模块划分与颜色](pin-gpu-design/shell-and-modules.md)：`PinShell` 接口与 Windows 实现、与 Tauri 的关系、模块与接缝、颜色管线设计。
- [6～7. 实测数据与对比](pin-gpu-design/measurements.md)：耗时、Edge 与全屏判定、内存显存、与 ULW 方案对比。

## 8. 风险

- **macOS 和 Linux 没有实测。** 0 错位在那两个平台是推断。尤其 GNOME 没有 layer-shell，钉图在 GNOME 上可能做不了置顶和自定位。
- **换窗时等合成偶尔到 30 ms。** 期间界面线程被 `DwmFlush` 卡住。正式方案应改成异步：拿 DWM 帧统计或 DComp 的帧 id 判断“已收下”，不阻塞线程。
- **包络窗口接住点击。** 手势中（最长到停手后 120 ms）包络里钉图外的空白处也是钉图窗口。可以 Swap 时一并设 `SetWindowRgn`（窗口区域只裁输入、不影响 DComp 内容，要实测），或者接受。
- **私有内存每张图涨得和显存一样多**，原因没查到。要按显示尺寸上传后再测。
- **多显示器、DPI 切换、键盘钩子**本原型没测；键盘沿用前一个原型的低级钩子结论。
- **wgpu 升级频繁**，API 每 12 周可能变。只有 `pin-render` 依赖它。
- **GPU 设备丢失**（驱动更新、远程桌面切换）：wgpu 会报 device lost，渲染层要能整个重建并重新上传。原型没处理。
- **核显、旧显卡**：只在 RTX 4070 SUPER 上测过。DX12 feature level 11_0 的老卡也能用 wgpu，但 DComp＋flip 交换链在老驱动上的表现要实测。

## 9. 工作量（估计）

| 部分 | 工作日 |
|---|---|
| `frame` 几何与 `plan`，并接上 `PinStore`、`EdgeHide`、`overlay_window` | 2～3 |
| `pin-render`：着色器、上传派生图、颜色 LUT、离屏比对测试 | 5～7 |
| Windows 平台壳：异步换窗、键盘钩子、穿透、多显示器与 DPI、设备丢失 | 5～7 |
| 编排：替换 #193 钉图层，菜单继续用 WebView，删掉旧层 | 5～8 |
| 验收：逐帧核对、门槛实验加钉图颜色、Edge、QUNS、焦点 | 3～5 |
| **Windows 合计** | **约 4～6 周** |
| macOS 平台壳（NSPanel＋CAMetalLayer）与实测 | 2～3 周 |
| Linux（Wayland layer-shell；GNOME 与 X11 另议） | 2～3 周＋GNOME 的不确定性 |

## 10. 需要的 ADR

1. **桌面钉图改为每张一个原生窗口、wgpu 绘制，可见窗口只平移、尺寸变化走备用窗口换上。** 取代 #193 的“每台显示器一个 WebView2 钉图层”，记下 ULW、单窗口 DComp、skia 这几个被否决的选项和理由。
2. **钉图的颜色转换由 Rust（moxcms）和着色器 LUT 完成。** 修订 ADR 0005：到屏幕的颜色转换从“只有 WebView2”变成“看图界面 WebView2、钉图 Rust”，两处都纳入门槛实验，钉图只显示派生图。
3. ADR 0011 不变，钉图沿用 `overlay_window` 的让出一行（本次实测再次确认需要）。
