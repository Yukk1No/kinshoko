# 框选截图计时

记录 F1 框选从按键到可用（#129）、确认到结果可用（#127）的各段耗时。框选路径有变化时，修复前后同条件各补一组。

## 测法

```
npx tauri build --no-bundle
node scripts/perf/capture-timing.mjs target/release/kinshoko.exe msedgedriver.exe [tauri-driver.exe]
```

脚本用独立的数据目录与 WebView 用户数据目录，不碰真实资料库。它生成合成原图（默认 `a-2400x1600.png,b-6000x4000.png,c-6000x4000.jpg,d-9000x6000.jpg,e-6000x4000.webp`，
可用 `KINSHOKO_CAPTURE_FIXTURES` 改），导入临时图库，逐张在查看器里打开后：

- **全局框选**：真实按下改绑的全局快捷键（Ctrl+Shift+F9），计 按键 → 抓屏完成（`grabbed`）→ 框选窗口就绪（`window.built`）→ 页面取到冻结屏幕（`frozen_screen`、`png.begin`／`png.end`）→ 显示（`shown`，此刻起可拖动）；
- **原图选区**：在参考图内框选后复制与钉住，计 确认 → 结果可用（剪贴板写好 `finish.end`／钉图第一帧显示 `pin.ready`）；
- **冷与热**：每张图第一次截取为冷，其后为热；第一张的第一次同时是应用冷启动后的首截；
- **托盘常驻**：最后关掉主窗口，隔 0／1.5／8 秒按快捷键，并记录常驻内存（与 [resident-memory.md](resident-memory.md) 同口径）。

阶段标记由应用在设置了 `KINSHOKO_CAPTURE_TIMING_LOG` 时追加到该文件（`capture.timing <阶段> at=<epoch 毫秒>`），未设置时不写。冻结屏幕是整个桌面，脚本不保存任何截图，只输出派生的毫秒数（`report*.json`，`summary` 字段为中位数／最大值）。

## 结果

| 日期 | 提交 | 机器 | 条件 | 首截按键→显示 | 重复按键→显示（中位／最大） | 冻结 PNG | 复制原图 确认→可用 | 钉住原图 确认→显示 | 托盘常驻内存 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 尚未测

- 修复前后在开发机上的同条件对比（填入上表）；
- 画师的无独显机器。
