# Windows 桌面参考：技术边界核验

核验日期：2026-10-03（Asia/Shanghai）。对应 [研究 Issue #5](https://github.com/Yukk1No/kinshoko/issues/5)，属于 [本地可用版本决策地图 #3](https://github.com/Yukk1No/kinshoko/issues/3)。本轮只阅读官方文档和固定源码，**未构建或运行桌面原型，未证明绘画体验、画质或性能**。

Tauri 2／WebView2 与 Qt 6／PySide6 都有置顶、忽略输入和 DPI 处理入口，可以保留为原型候选。锁定、固定局部、原图读取与物理像素 1:1 要由应用落实；文档不能替代绘画软件、画笔、混合 DPI 和大图的运行验证。[Tauri 窗口 API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)、[Qt 窗口标志](https://doc.qt.io/qt-6.8/qt.html#WindowType-enum)

## 输入与证据范围

沿用 [领域共识基线 `90bef426`](https://github.com/Yukk1No/kinshoko/blob/90bef426bf0899f0341c3f407574826aa0ad794c/docs/discovery/data-storage-model.md)：局部在钉图前选定，桌面移动和显示缩放不改变边界；成员状态独立；锁定阻止移动、调整尺寸与显示缩放；鼠标穿透独立选择且可可靠退出。Q44／Q45 已确认先用公开／自制样本，覆盖不足才补少量真实素材；无独显 Windows 电脑也能完成核心流程，GPU 用于加速。[地图 Notes](https://github.com/Yukk1No/kinshoko/issues/3)

下文的“官方支持”仅表示接口或规范明确描述该行为；“推论／建议”表示据此提出的实现或原型取舍；“待原型”表示尚无运行证据。Qt 引用使用 6.8 版文档；源码观察点是 [Qt v6.8.3，`c07c2d5a`](https://github.com/qt/qtbase/blob/c07c2d5a527a644d36e7853d55132ae38921682f/src/plugins/platforms/windows/qwindowswindow.cpp) 和 [Tauri v2.8.5，`80eadb73`](https://github.com/tauri-apps/tauri/blob/80eadb7387459639037e3a279c61c9631b1dafe7/packages/api/src/window.ts)。这些版本用于复查证据，不是正式依赖版本决策；实施时另锁定实际 SDK、运行时及打包工具。

## 窗口与退出入口

| 需求 | Tauri 2／WebView2：官方入口 | Qt 6／PySide6：官方入口 | 应用职责与待原型边界 |
|---|---|---|---|
| 置顶 | `setAlwaysOnTop(true)`／`alwaysOnTop`。[窗口 API](https://v2.tauri.app/reference/javascript/api/namespacewindow/#setalwaysontop) | `Qt.WindowStaysOnTopHint`。[窗口标志](https://doc.qt.io/qt-6.8/qt.html#WindowType-enum) | Win32 的 `HWND_TOPMOST` 保持在非置顶窗口之上，包括失去焦点时；这不保证盖住其他置顶窗口。绘画软件全屏、切换焦点和多张钉图层序待测。[SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos) |
| 独立穿透 | `setIgnoreCursorEvents(true/false)`，调用返回成功／失败结果。[API](https://v2.tauri.app/reference/javascript/api/namespacewindow/#setignorecursorevents) | 顶层窗体 `Qt.WindowTransparentForInput` 明确要求输入穿过。Windows 固定源码使用 `WS_EX_LAYERED | WS_EX_TRANSPARENT`。[标志](https://doc.qt.io/qt-6.8/qt.html#WindowType-enum)、[平台源码](https://github.com/qt/qtbase/blob/c07c2d5a527a644d36e7853d55132ae38921682f/src/plugins/platforms/windows/qwindowswindow.cpp#L784-L787) | 穿透与锁定分别保存、分别切换。鼠标点击、滚轮和画笔实际是否交给下面的绘画软件待测；不能由“ignore cursor”推定所有设备成功。 |
| 透明窗体 | `transparent` 配置提供入口。WebView2 背景色只支持全透明或全不透明，不能把该属性当作任意半透明设置。[Tauri 配置](https://v2.tauri.app/reference/config/#transparent)、[DefaultBackgroundColor](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.defaultbackgroundcolor) | `WA_TranslucentBackground` 加非不透明绘制；Windows 需要 `FramelessWindowHint`。[QWidget](https://doc.qt.io/qt-6.8/qwidget.html#creating-translucent-windows) | 视觉透明、图片半透明和输入穿透分别验证。开启透明不是开启整窗穿透；透明区域的命中行为也不能代替显式开关。 |
| 锁定 | `setResizable(false)`、拖动入口及 Webview 缩放入口可由应用控制。[窗口 API](https://v2.tauri.app/reference/javascript/api/namespacewindow/#setresizable)、[setZoom](https://v2.tauri.app/reference/javascript/api/namespacewebview/#setzoom) | 固定尺寸及拖动／滚轮事件处理提供实现手段。[QWidget](https://doc.qt.io/qt-6.8/qwidget.html#setFixedSize) | **推论：锁定是业务状态，不是某个 OS 标志。** 所有移动、尺寸、缩放命令都检查锁定；钉图阶段始终不编辑局部边界。浏览器默认缩放、系统移动／最大化和触控手势均需验证，不能仅隐藏按钮。 |
| 无焦点退出穿透 | 官方 `global-shortcut` 插件提供 Windows 全局注册和 Rust／JS 回调；JS 调用须启用 capability 权限。[插件](https://v2.tauri.app/plugin/global-shortcut/) | `QShortcut` 即使使用 `ApplicationShortcut` 也需要应用窗口处于活动状态。Windows 可用 `RegisterHotKey`，由 `QAbstractNativeEventFilter` 收到注册热键的原生消息。[快捷键上下文](https://doc.qt.io/qt-6.8/qt.html#ShortcutContext-enum)、[PySide 原生事件过滤器](https://doc.qt.io/qtforpython-6.8/PySide6/QtCore/QAbstractNativeEventFilter.html) | **建议：先成功注册退出热键再允许穿透。** 冲突时提示换键，不能显示已准备就绪；回调在宿主侧执行解除穿透，避免退出依赖被遮挡页面的焦点。 |
| 独立恢复入口 | 原生托盘菜单支持宿主动作。[系统托盘](https://v2.tauri.app/learn/system-tray/) | `QSystemTrayIcon` 支持 Windows 托盘与菜单。[Qt 托盘](https://doc.qt.io/qt-6.8/qsystemtrayicon.html) | **建议：** 保留不穿透的管理窗口／托盘“恢复交互、关闭钉图、退出”。全局热键和托盘都依赖宿主事件循环；应用完全卡死时不是可靠恢复保证，不能宣称绝不困住用户。 |

`RegisterHotKey` 是系统级热键，匹配时投递 `WM_HOTKEY`；已被注册的组合通常失败，F12 保留给调试器，Windows 键组合保留给 OS，`MOD_NOREPEAT` 可避免长按重复。实际注册失败、热键占用和失去焦点后的退出必须作为验收场景。[RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)

必要的 Win32 扩展应先局限于热键或框架表现不满足要求的位置。Microsoft 文档明确保证 layered window 加 `WS_EX_TRANSPARENT` 时鼠标事件交给下方窗口；单独从名称推定 `WS_EX_TRANSPARENT` 可用不充分。`WM_NCHITTEST` 返回 `HTTRANSPARENT` 只描述向**同线程**下层窗口继续命中，不能单凭它承诺穿透到另一进程的绘画软件。[Layered Windows](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#layered-windows)、[WM_NCHITTEST](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-nchittest)

Qt `setWindowFlag(s)` 变更窗体标志会使 widget 隐藏，官方要求重新 `show()`。**待原型：** 连续切换置顶／穿透后的可见性、焦点、窗口位置及热键关联是否仍正确。[QWidget windowFlags](https://doc.qt.io/qt-6.8/qwidget.html#windowFlags-prop)

## 固定局部、1:1 与多显示器 DPI

**官方支持：** Canvas `drawImage` 与 Qt `QPainter.drawImage` 均可指定来源区域及目标区域，因此有实现固定局部的绘制入口；Canvas 规范并不指定所有缩放场景的精确插值算法。存在接口不等于已保留原图细节，也不等于已实现低内存区域解码。[HTML Canvas](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-drawimage)、[QPainter](https://doc.qt.io/qt-6.8/qpainter.html#drawImage)

**建议作为原型定义：** 1:1 表示“完成方向校正后的一个原图像素对应一个屏幕物理像素”。它不同于一个原图像素对应一个 CSS pixel／Qt 逻辑像素，也不同于图像的打印 DPI。若当前实际像素比为 `d`，宽 `W` 的局部在 1:1 时占 `W` 个物理像素、`W/d` 个逻辑单位；例如 300 像素局部在 150% 显示器上应占 200 逻辑单位。此定义还需原型反馈确认；采用后，跨屏保持 1:1 会改变逻辑尺寸。

| 候选 | 官方证据 | 对原型的约束 |
|---|---|---|
| Tauri／WebView2 | Tauri 提供物理／逻辑尺寸、显示器比例与 `onScaleChanged`；WebView2 区分 `ZoomFactor`、`RasterizationScale` 和 Bounds 的像素模式。Web 规范的 `devicePixelRatio` 还反映页面缩放。[Tauri 固定源码](https://github.com/tauri-apps/tauri/blob/80eadb7387459639037e3a279c61c9631b1dafe7/packages/api/src/window.ts)、[WebView2 缩放与尺寸](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis#rasterization-scale)、[CSSOM View](https://drafts.csswg.org/cssom-view/#dom-window-devicepixelratio) | 不把 OS 比例和 WebView 页面比例重复相乘。原型固定页面 zoom 为 1，关闭／检查默认页面缩放，将成员比例用于图像绘制；Canvas 位图尺寸与 CSS 显示尺寸分别设置。以运行时实际值核验映射，不只看“100%”文字。 |
| Qt／PySide6 | Qt 6 在 Windows 默认 Per-Monitor DPI Aware V2；窗口几何使用设备无关单位，图像仍有实际像素尺寸。混合 DPI 下屏幕逻辑几何可能出现间隙，不能假定相邻坐标必属另一屏。[Qt High DPI](https://doc.qt.io/qt-6.8/highdpi.html) | 使用当前窗口实际 DPR 计算目标尺寸，注意图片自身 DPR（包括 `@2x` 名称影响）。枚举显示器可用区域，处理负坐标、拔屏和位置恢复；不要将本机桌面像素位置写成来源裁切。 |

Win32 `GetDpiForWindow` 的结果受窗口 DPI awareness 影响；`WM_DPICHANGED` 通知换屏或显示器比例变化，并给出建议窗体矩形。框架已处理的消息不要再盲目重复缩放；原型需记录实际窗口 awareness、比例与物理尺寸，确认不会被系统位图拉伸。[GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow)、[WM_DPICHANGED](https://learn.microsoft.com/en-us/windows/win32/hidpi/wm-dpichanged)

## 方向、颜色、大图与无独显

| 边界 | 已核验事实 | 推论／待原型 |
|---|---|---|
| 原图与方向 | Web 的 `image-orientation: from-image` 表达 EXIF 校正；Qt `setAutoTransform(true)` 应用变换元数据，但 `QImageReader.setClipRect` 坐标相对**未变换**尺寸。[CSS Images](https://www.w3.org/TR/css-images-3/#the-image-orientation)、[QImageReader](https://doc.qt.io/qt-6.8/qimagereader.html#setClipRect) | 按领域基线统一方向校正后的坐标。Qt 可先校正再裁切，或显式逆变换裁切坐标；不能直接把成员 crop 交给解码器。以方向 1–8 的样本核验旋转、镜像、宽高及双重校正；显示读取原文件，预览缓存不能冒充原图。 |
| 颜色与透明像素 | Web 色彩规范要求识别图像色彩空间，未标记图像按 sRGB 解释。Qt 的 `QColorSpace` 与 `QImage.convertToColorSpace` 提供转换；`setColorSpace` 只赋标记、不转换像素，`fromIccProfile` 不支持所有 ICC，6.8 文档限定 RGB／Gray。[CSS Color](https://www.w3.org/TR/css-color-4/#untagged)、[QColorSpace](https://doc.qt.io/qt-6.8/qcolorspace.html#fromIccProfile)、[QImage](https://doc.qt.io/qt-6.8/qimage.html#setColorSpace) | 不推定 Qt 默认绘制会自动完成到显示器 ICC 的整条链路，也不由 Web 规范宣称当前 WebView2 已通过画师屏幕验收。比较 sRGB、带／不带 ICC、广色域、灰阶和透明边缘；CMYK、HDR／显示器色彩管理需求若样本涉及，应另核验，不能仅承诺“颜色不变”。 |
| 大图与格式 | Qt 可查询 `supportedImageFormats`、解码错误和分配上限；区域／缩放读取的内存收益依赖具体格式解码器。[QImageReader](https://doc.qt.io/qt-6.8/qimagereader.html) | 两类候选都不能由“能裁切显示”推出“不解码整图”或“支持任意尺寸”。估算：20,000×20,000 的一份 32-bit 像素缓冲约 1.6 GB，尚未计入副本和缓存。记录内存峰值、解码／首次清晰显示时间及可取消性；不足再考虑分块／有界缓存。格式清单以实际解码器、插件和打包结果验收。 |
| 无独显可用 | Qt Widgets 的默认 raster 绘制是软件渲染；WebView2 默认用 GPU 渲染，Microsoft 建议只在排障时禁用 GPU。[Qt 图形](https://doc.qt.io/qt-6.8/topics-graphics.html#high-level-graphics-with-qt-gui)、[WebView2 性能](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance#enable-hardware-acceleration) | Qt Widgets 是验证软件绘制的直接入口；Tauri 不能因默认使用 GPU 就推定必须有独显，无独显／集显机器仍须实际验收。不要为模拟无独显默认加 `--disable-gpu`。Qt Quick、OpenGL、WebGL 或额外效果改变渲染前提后需另测；静态钉图不必先依赖它们。 |

大图解码或缩放若阻塞接收全局热键的宿主事件循环，会影响退出穿透。**建议：** 原型把耗时工作移出该循环，使用可观察的加载／失败状态；清晰显示前后的响应和内存必须一起记录。此处没有设定已经通过的性能数字。

## 部署与许可证条件

| 候选 | 官方支持／条件 | 后续需核对 |
|---|---|---|
| Tauri 2 | Windows 提供 MSI／NSIS 安装包，WebView2 安装可选下载 bootstrapper、离线安装器或随应用携带 fixed runtime。生产需要 WebView2 Runtime；“装有 Edge”不足以代替检查。Evergreen 自动更新；Fixed Version 由应用负责更新。[Tauri Windows 安装](https://v2.tauri.app/distribute/windows-installer/)、[Microsoft 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) | 离线首次安装不能只带在线 bootstrapper。记录并复验 Runtime 版本变化；打包大小、最低 Windows 版本、架构和标准用户安装以选定版本的实际包验证。 |
| Tauri／WebView2 许可证 | Tauri 本身 MIT／Apache-2.0 二选一，上游依赖各有许可证。Microsoft 的 WebView2 SDK 1.0.4258.31 许可证允许再分发并要求保留版权、条件和免责声明，禁止无许可使用 Microsoft 名义背书；Runtime 是另一个可再分发组件。[Tauri 许可](https://v2.tauri.app/concept/architecture/#license)、[SDK 固定版本许可](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31/License)、[Runtime 分发模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version) | 原型与正式包保留依赖清单及所用版本许可。SDK 许可不能代替 Runtime 下载包条款；本轮未逐字审阅最终待选 Runtime 包的 EULA，发布前保存并核对。 |
| Qt 6／PySide6 | PySide6 是 Qt 官方 Python 绑定，提供 LGPLv3／GPLv3／商业许可。`pyside6-deploy` 基于 Nuitka，可产出 Windows exe，支持 onefile／standalone。[Qt for Python](https://doc.qt.io/qtforpython-6.8/index.html)、[官方部署工具](https://doc.qt.io/qtforpython-6.8/deployment/deployment-pyside6-deploy.html) | 可打包供无 Python 环境使用；实际需包含所用 Qt DLL、Windows platform plugin、图片插件和资源。在干净设备核验，开发机上能打开图片不等于包内格式支持完整。 |
| Qt 许可落地 | LGPL 路线需满足许可文本／显著声明、Qt 对应源码提供、用户替换／重新链接兼容库及相关调试逆向权利等；部分 Qt 模块只提供 GPL 或商业许可。[Qt 官方义务](https://www.qt.io/development/open-source-lgpl-obligations)、[LGPLv3 第 4 条](https://doc.qt.io/qt-6.8/lgpl.html) | 不把“动态链接”或“onefile”本身当作合规结论。逐项核对实际模块、图片插件、Python 与打包工具许可证，并验证 DLL 替换办法；不愿履行相应开源条件时再评估商业许可，不能预设必须付费。 |

## 最小原型必须验证

只做读取少量静态原图、选定整图／局部、两张独立钉图和退出入口。先用公开／自制样本：像素网格、细线／纹理、EXIF 方向 1–8、ICC／透明图、常用静态格式、超大图和损坏文件；覆盖不足再补画师真实素材。

| 检查 | 最少通过条件／记录 |
|---|---|
| 固定局部与状态恢复 | 同一原图左眼／右眼作为不同成员；移动和显示缩放不改变任何 crop，组复制及保存／加载后显示同一区域。记录来源哈希、方向校正后宽高和裁切坐标。 |
| 1:1 与画质 | 100%、125%、150%、200% 及混合 DPI 下像素网格可核对到物理像素；检查整图／局部、整数／非整数缩放、裁切边缘和透明边缘。记录绘制路径与过滤方式，画师判断细节是否满足观察需求。 |
| DPI 与桌面位置 | 双屏间来回移动，含负坐标；改变比例、拔屏并重启。比例更新一次，内容不漂移；窗口可恢复到可见区域。锁定时设备 DPI 变化怎样保持显示意图需由结果细化。 |
| 锁定 × 穿透 | 四种组合分别检查：拖动、边缘调整、滚轮、Ctrl 缩放和手势符合锁定状态；穿透不会自动改锁定或 crop。切换后无丢窗、错位或意外夺取绘画焦点。 |
| 置顶与实际输入 | 在目标绘画软件普通／最大化／全屏状态、Alt+Tab 和多张钉图下检查层序；鼠标与画笔实际落到下方画布，观察是否丢首笔、抬笔或滚轮。 |
| 退出穿透及失败路径 | 所有钉图穿透且绘画软件有焦点时，热键能恢复交互；重复／长按、占用注册失败、托盘菜单、关闭窗口、解码进行中及重启后逐一验证。失败时不得进入无可用退出入口的状态。 |
| 颜色、格式与大图 | 已知 ICC／方向样本与认可的绘画软件显示进行对照，记录 OS、显示器配置及差异；格式／损坏／内存上限错误可辨认。记录无独显机器的首次清晰显示时间、内存峰值及交互响应，验收阈值另由使用反馈决定。 |
| 可复现部署 | 留下版本锁定、样本许可／哈希、运行命令、测试机器配置和结果。在无开发环境的标准用户、离线首次启动场景验证安装包和退出入口；只把实际执行通过的格子标为通过。 |

**有条件的候选建议（推论）：** 若首个原型主要回答桌面钉图、方向校正和无独显软件绘制，可先试 **PySide6＋Qt Widgets**，用小范围 Win32 全局热键补齐无焦点退出，并承担 Qt 许可及打包核对。若后续主界面倾向 Web／Rust、愿意验证 WebView2 的 DPI／页面缩放与运行时部署，可先试 **Tauri 2**，利用官方全局快捷键与托盘入口。两条路线都需完成上述清单；当前证据不足以比较实际画质、内存或操作体验，也不据此冻结正式框架。
