# 原生钉图 GPU 方案：0 错位：怎么做到

[总览](../pin-gpu-design.md)

## 2. 0 错位：怎么做到

### 问题在哪

一帧画面错位，是因为窗口几何（位置、尺寸）和窗口内容是两件事，合成器不保证它们同一帧生效。对照组“一个窗口，每帧 `SetWindowPos` 改尺寸＋Present”实测：

| 对照组 | 核对帧数 | 对上 | 对不上任何一次提交 | 画面倒退 |
|---|---|---|---|---|
| 先改窗口再 Present | 1 497 | 1 184 | **65** | 2 |
| 先 Present 再改窗口 | 1 442 | 1 199 | **11** | 0 |

（其余是钉图放到画面里看不到品红、或半透明期间不核对的帧。）

前一个原型的 DComp＋D2D 组约 4% 帧错位，这里同样如此，所以错位与用不用 wgpu 无关，是“改尺寸”这件事本身的问题。ULW 没有这个问题，因为它一次调用同时交几何和像素，代价是像素必须在 CPU 上。

### 规则

看得见的窗口**只许平移，不许改尺寸**。每一帧由纯函数 `plan(window, drawn, content, clip, gesture)` 决定怎么上屏：

| 情况 | 做法 | 为什么不错位 |
|---|---|---|
| 内容还在当前窗口里（窗口没变） | **Redraw**：只重画、Present | 一次 Present 本身是原子的 |
| 内容与窗口一起平移、像素不变（拖动） | **Move**：只 `SetWindowPos` 挪窗口 | 窗口里的合成内容跟着窗口走，不重画 |
| 其余（尺寸要变） | **Swap**：在看不见的备用窗口上摆好、画好，等合成器收下，再**一次提交**把新的设成看得见、旧的设成看不见 | 可见性切换在同一次提交里，合成器同一帧生效；两个窗口各自的几何和内容都是稳定的 |
| 内容完全在显示器外 | **Hidden**：什么都不做 | — |

为了让 Swap 少发生：手势进行中（滚轮、动画，停手 120 ms 前）换上来的窗口是“包络”，即以需要的矩形为中心放大到两倍、夹在显示器里。之后放大约 2 倍以内、或任意缩小都只需 Redraw。停手后再 Swap 一次，把窗口收成刚好盖住钉图（含阴影一圈 `PIN_EDGE`）。钉图比屏幕大时，窗口就是整台显示器（照 ADR 0011 让出最下面一行），之后的平移、缩放都是 Redraw。

### Windows：实测

两个槽是两个 `WS_EX_NOREDIRECTIONBITMAP` 窗口，各有一个 DComp target 和根 visual，挂在同一个 `IDCompositionDesktopDevice` 上。Swap 的步骤：

1. 备用槽 `SetWindowPos` 到新矩形，摆在可见槽紧下面（不透明度本来就是 0）；
2. wgpu 往备用槽的交换链画、Present；
3. `DwmFlush`：等到下一次合成，此时已提交的 DX 表面更新和窗口摆放都已生效；
4. 新槽 `SetOpacity(1)`、旧槽 `SetOpacity(0)`，`Commit` 一次；拖动中把指针捕获交给新槽；
5. 两个刷新周期后隐藏旧槽。

逐帧核对：另开线程用 DXGI 桌面复制取 DWM 合成的每一帧，只把钉图附近读回内存，不存盘。找品红外框，它必须正好是某一次提交时看得见的那几条边框的外框（被屏幕裁过的按裁后算）；左边框完整时再量边框宽度，它要等于那次提交的缩放对应的宽度。自测用 `PostMessage` 投滚轮、直接改拖动状态，不动真实鼠标，覆盖这几种情况：

- 一格一帧放大到比屏幕大再缩回；
- 每帧三格；
- 隔 150 ms 一格（手势反复开始结束）；
- 拖出屏幕一半再拖回；
- 旋转翻转；
- 250 ms 动画；
- 比屏幕大时拖动缩放；
- 透明度。

| 两槽换窗 | 核对帧数 | 外框、边框都对上 | 外框对上（被裁过，不量边框） | 边框不符 | **对不上任何提交** | 应看得见却没有品红 | 画面倒退 |
|---|---|---|---|---|---|---|---|
| 第 1 轮 | 1 537 | 787 | 555 | 0 | **0** | 0 | 0 |
| 第 2 轮 | 1 507 | 682 | 607 | 0 | **0** | 0 | 0 |

每轮 612 次提交里约 410 次在屏幕上被核对到（其余在两次合成之间就被下一次覆盖了）。

核对工具本身改过两处，都是误报方向的修正：一是钉图大到上、下、左边框都在屏幕外时，品红只剩右边框一条，原来的核对把它当成对不上；二是第一帧原来没有登记。改完后对照组照样抓到错位，说明工具没有变松。

### macOS：推断

- **窗口**：每个槽一个 `NSPanel`（`nonactivatingPanel`，`level = .floating` 或更高，`hidesOnDeactivate = false`，`collectionBehavior` 含 `canJoinAllSpaces | fullScreenAuxiliary`），内容视图挂 `CAMetalLayer`（`opaque = false`，wgpu 的 Metal 后端支持预乘）。
- **0 错位**：Core Animation 本身就是事务模型。做法一，和 Windows 相同：两个面板，在一个 `CATransaction` 里交换两个 layer 的 `opacity`（或面板 `alphaValue`），面板 frame 只在看不见时改。做法二，单面板：`CAMetalLayer.presentsWithTransaction = true`，在同一个事务里改面板 frame 和 Present。苹果文档说明这样 drawable 随事务一起提交，可以和窗口改尺寸同步（这正是它的用途）。做法一不依赖这个保证，和 Windows 的 trait 一致，优先用它。
- **要实测的**：面板在别的程序全屏的 Space 上是否显示；`NSWindow.setFrame` 与 CA 事务在同一 runloop 轮次是否同帧（做法二）。

### Linux：推断

- **Wayland**：协议本身就是原子的。一个 `wl_surface` 的缓冲、viewporter 目标尺寸，以及 layer-shell 的尺寸和边距，都是“双缓冲状态”，在同一次 `commit` 一起生效。wgpu 的文档也说明，Wayland 上 `present` 就是 attach＋commit，所以 viewporter、layer-shell 的状态在 present 之前设好，就和这一帧一起生效。可以单窗口做 0 错位，不需要两个槽（trait 的 Swap 退化成“改好状态再 Present”）。
  - 定位和置顶要靠 `wlr-layer-shell`（KDE、wlroots 系、Hyprland、COSMIC 都有）。**GNOME 没有 layer-shell**：普通 `xdg_toplevel` 不能自己决定位置，也不能置顶。GNOME 上要么不支持钉图，要么退到 Xwayland。这是 Linux 最大的风险。
- **X11**：override-redirect 的 ARGB 窗口，置顶、不抢焦点都能做。X 没有“几何和内容同帧”的保证，用两个窗口交换（`_NET_WM_WINDOW_OPACITY` 或 map/unmap）也依赖合成器，只能尽力而为。
- 输入穿透：Wayland 设空的 input region，X11 用 XShape 的 input shape。
