# native-pin-probe

丢弃型原型：每张钉图一个原生分层窗口（`UpdateLayeredWindow`），不用 WebView 画。结论与实测数字见
[`docs/discovery/native-pin-prototype.md`](../../docs/discovery/native-pin-prototype.md)。不接入正式代码。

```
cargo build --release
target/release/kinshoko-native-pin-probe --gen <临时目录>          # 生成 photo.jpg、marker.png、p3.png
target/release/kinshoko-native-pin-probe <图片>...                 # 钉出来手动试
```

钉图上：滚轮以光标为中心缩放（每格 10%）、左键拖动、右键占位菜单；光标在钉图上时 H／V 翻转、R 顺时针转 90°、
C 裁切、T 点击穿透、`[`／`]` 透明度、N 放大时按像素、A 动画、1 回到 100%、Esc 关掉（全关后退出）。

测量（都会在屏幕上弹出钉图，先确认没人在用这台电脑）：

| 命令 | 作用 |
|---|---|
| `--info` | 显示器、刷新率、配置文件、色彩模式（SDR／ACM／HDR）、`SHQueryUserNotificationState` |
| `--selftest 报告.txt [--verify] <图>` | 自动缩放、旋转、动画、拖动、裁切、透明度，记耗时（旁边写 `.csv` 明细）；`--verify` 用桌面复制逐帧核对，要钉 `marker.png` |
| `--compare <宽度> <图>` | 与应用管线 `render_sdr` 缩到同一宽度逐像素比较（不弹窗口） |
| `--input-test <图>` | **动真实鼠标键盘**：前台放一个别的程序，测拖动、滚轮、按键、菜单、穿透时前台有没有变 |
| `--hold <毫秒>` | 钉住一段时间后退出（配合 `scripts/edge-frames.mjs`、`scripts/gpu-memory.ps1`） |

选项：`--backend ulw|dcomp`（对照组）、`--move-first`（DComp 先改窗口再 Present）、`--count N`（每张图钉 N 份，各读一份）、
`--scale X`、`--no-icc`、`--full-screen-ok`（不让出最下面一行）、`--menu-foreground`、`--gesture-interp`、`--settle-from-full`、`--threads N`。
调试：环境变量 `NATIVE_PIN_DUMP=<目录>` 时，逐帧核对对不上的帧把读回的那一小块存成 PNG（会含钉图背后的一点桌面，用完删掉）。

`scripts/edge-frames.mjs <端口>`：Edge 以独立配置目录、`--remote-debugging-port`、`--start-maximized` 启动后，读页面的
`visibilityState` 并数 1 秒内的 `requestAnimationFrame` 回调。`scripts/gpu-memory.ps1`：读 dwm 与原型进程的 GPU 内存计数器。
