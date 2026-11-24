# 原生钉图真机验收（#287）

2026-10-26，开发机：Windows 11 26H2（26300.9711），RTX 4070 SUPER（驱动 32.0.16.2101），一台 2560×1440 显示器、显示缩放 110%、`color-gamut: srgb`、SDR，WebView2 155.0.4283.62。release 构建的测试实例（identifier `dev.kinshoko.pintest`、独立 `KINSHOKO_DATA_DIR`），跑法见[发布前检查清单：桌面钉图](release-checklist-pins.md)。截屏只取钉图附近一块（桌面复制），没有截图进仓库。

## 结果

| 检查 | 结果 |
| --- | --- |
| 逐帧核对 `pin-frame-check --app` | 通过：取到 729 帧、核对 518 帧，外框与边框都对上 433、外框对上（被裁过）72，**外框对不上任何提交 0**，应看得见却没有品红 0，画面倒退 0；提交 538 次；前台始终是收键窗口 |
| `capture_pin.py` | 5／5 |
| `edge_restore.py` | 13／13 |
| `pin_backdrop.py`（#275） | 10／10，见下表 |
| `pin_device_loss.py` | 7／7：设备丢失后 **673 ms** 重新显示（前一轮 653 ms），位置不变、与测试图逐像素一致、之后滚轮能缩放 |
| 门槛实验“钉图 vs 查看器 1:1” | 通过：计入门槛的 34 个样本最差色块 ΔE2000 **0.60**（`alpha-edge`），8 位差最大 1 |

### 背后的程序（`pin_backdrop.py`）

Edge 以独立配置目录、`--disable-extensions --disable-sync` 最大化启动，页面每帧动一下。没有钉图时 rAF 171／秒。

| 场景 | 背后页面 | rAF／1 秒 | QUNS | 前台 |
| --- | --- | --- | --- | --- |
| 1 张钉图 | visible | 171 | ACCEPTS_NOTIFICATIONS | 不变 |
| 8 张钉图 | visible | 171 | ACCEPTS_NOTIFICATIONS | 不变 |
| 滚轮缩放中（换窗） | visible | 171 | ACCEPTS_NOTIFICATIONS | 不变 |
| 一张盖满屏幕（窗口 2560×1439，让出一行）＋7 张 | visible | 171 | ACCEPTS_NOTIFICATIONS | 不变 |
| 钉图菜单开着 | visible | 171 | ACCEPTS_NOTIFICATIONS | 菜单（只记录） |
| F1 框选中 | visible | 171 | ACCEPTS_NOTIFICATIONS | 框选窗口（只记录） |
| F1 收起后 | visible | 171 | ACCEPTS_NOTIFICATIONS | 不变 |
| Edge 全屏（F11） | visible | 171 | BUSY（Edge 自己全屏，只记录） | 不变 |
| Kinshoko 主窗口最大化在钉图背后 | visible | 172 | ACCEPTS_NOTIFICATIONS | 不变 |

### 门槛实验

主显示器按它的配置文件（sRGB）建查找表；Windows 自动色彩管理没有开（`color-gamut: srgb`）。开发机没有校准 ICC，合成的校准 ICC 由 CI 的 `pin-render` 离屏测试覆盖；ACM 下的现状交给真机确认。

| 样本 | 最差色块 ΔE2000 | 样本 | 最差色块 ΔE2000 |
| --- | --- | --- | --- |
| p3-v4.jpg | 0.49 | gama-chrm-p3.png | 0.32 |
| p3-v2.jpg | 0.49 | cicp-p3.png | 0.04 |
| adobe-rgb.jpg | 0.00 | png16-p3.png | 0.00 |
| lut-a2b0.png | 0.32 | alpha-edge.png | 0.60 |
| lut-lab.png | 0.49 | alpha-edge.webp | 0.60 |
| cmyk-profile.jpg | 0.26 | animated.gif／png／webp | 0.01 |
| cmyk-naive.jpg | 0.01 | gain-map.jpg | 0.01 |

其余计入门槛的样本（EXIF 方向 1～8、gAMA、ICC 不符、YCCK、灰度）都 ≤ 0.04。

## 验收中查出并修好的

- **GPU 设备丢失后钉图不会回来。** 渲染层有 `rebuild`，应用却没接上：设备丢了以后每次绘制都失败，钉图一直停在丢失前的画面（或消失）。现在渲染线程在出错时和空闲时每 250 ms 查一次，丢了就丢掉所有 Surface、图与设备，编排给每张钉图向平台层要新目标、重新读图、画好再显示。测试钩子 `KINSHOKO_PIN_LOSE_DEVICE_MS`。
- **钉图菜单开着时背后的程序停画（#275 的原因还在菜单窗口上）。** 菜单窗口仍是铺满显示器的透明 WebView 窗口，没标成工具窗口，Chromium 的遮挡判定把它算成不透明：第一轮实测菜单开着时背后的 Edge `hidden`、rAF 0。菜单窗口建好后加 `WS_EX_TOOLWINDOW`，复测 visible、171。
- **逐帧核对工具拖角缩回时按在了钉图外。** 工具放大后只等约 30 ms 就按“按光标估的角”开始缩回，角还在缩放动画里、差 8～16 像素，点击落到背后的窗口、抢走前台。改为等动画走完，从角的实际位置开始。
- 探针的两处测法问题：控制台按 GBK 输出时打印 ✓ 失败（要设 `PYTHONIOENCODING=utf-8`）；Claude 桌面应用或别的程序自己回到前台时，测试窗口拿不到前台，前台检查会失败，跑之前把它们最小化。

## 交给真机确认

开发机只有一块显示器、没有数位板、没有核显，下面这些在 beta 上由维护者确认（详见[清单](release-checklist-pins.md)的“真机”几节）：

- 画师电脑：#193 缩放不抽不闪；#275 背后最大化的优动漫、浏览器与 Kinshoko 主窗口照常刷新（钉图、F1、菜单）。
- 数位板：笔拖动、拖角缩放跨换窗不断，贴边后笔立即能画，笔侧键与按住开菜单（Windows Ink、WinTab）。
- 两台缩放比例不同的显示器：跨屏拖动、缩放、贴边，尺寸不跳，颜色换 LUT；改缩放比例、换配置文件、插拔显示器。
- 真实的设备丢失：远程桌面切换、Win+Ctrl+Shift+B。
- 一台核显电脑；Windows 10 点击穿过；“悬停时滚动非活动窗口”关掉；Wallpaper Engine 与专注助手；ACM 开着时的门槛实验。
