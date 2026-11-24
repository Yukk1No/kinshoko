# 原生钉图端到端验收（#284）

2026-10-26，Windows 11，主显示器 2560×1440、sRGB 配置文件，release 构建的测试实例（identifier `dev.kinshoko.pintest`、独立 `KINSHOKO_DATA_DIR`，`settings.json` 里 `"nativePins": true`）。截图只截钉图区域，在 `native-pin-284/`。

## 打开开关

> #286 起开关已删除，原生钉图始终启用；下面是当时的做法。

数据目录的 `settings.json` 加 `"nativePins": true`，重启应用。默认关，设置界面不显示，关着时不写进文件；开关每次启动只读一次（恢复钉图或第一次钉图时），运行中改文件不生效。

## 结果

| 项 | 结果 |
| --- | --- |
| 剪贴板钉图 100%（`clipboard-100.png`） | 400×600 与剪贴板图逐像素比较，0／240000 不同 |
| 资料库钉图 100%（`library-100.jpg`，从 `pins.json` 恢复） | 0／240000 不同；离屏测试 `a_library_pin_at_100_percent_is_the_original_pixel_for_pixel` 在 CI 上同样走派生图 → 线性 → 查找表 → 画 |
| 资料库钉图 50%（`library-50.jpg`） | 用 `fit-300` 派生图 |
| Ctrl+滚轮（`opacity-50.jpg`） | 透明度 0.5，写回 `pins.json` |
| 滚轮缩放（`zoom.jpg`） | 以光标为中心，停 120 ms 后按显示尺寸重取派生图 |
| 拖动（`drag.jpg`） | 只平移，不重画 |
| Esc | 关掉钉图，`pins.json` 去掉该条，最后一张关掉后平台层与 GPU 设备释放 |
| 逐帧核对 `pin-frame-check --app` | 取到 722 帧，核对 582 帧：外框与边框对上 537、被裁过只对外框 45，**对不上任何一次提交 0**，画面倒退 0；提交 223 次；前台始终是收键窗口 |
| 背后最大化的 Edge（独立配置目录） | 静止、滚轮缩放中、拖动中、操作之后：`visibilityState=visible`，rAF 171／172／171／171 每秒；Edge 始终最大化未最小化，前台窗口全程未变（钉图不抢前台） |

## 已知

- Kinshoko 自己的主窗口在前台时，低级键盘钩子收不到注入的 Esc（别的窗口在前台时正常），留给 #285／#287 看。
- arboard 读不了 `CF_DIBV5`（`BI_BITFIELDS`）的剪贴板图，核对工具改放注册格式 `PNG`。
