# 开发机：模拟键鼠检查

在开发机上用探针构建运行：它换掉了 identifier，全局快捷键改成 F13～F15，数据放在临时目录，所以可以与已安装、正在运行的 Kinshoko 和 Snipaste 同时存在（[guard.py](../../scripts/probe/guard.py)）。

```bash
npx tauri build --no-bundle --config scripts/probe/tauri.probe.json
```

运行期间不要碰键鼠。前台是别的全屏程序（例如游戏）时探针立即退出，不注入输入；三个探针共用一把输入锁，别的探针或会话占着鼠标键盘时也立即退出。

| 检查 | 命令 | 100% | 125% | 150% |
|---|---|---|---|---|
| 截图钉图逐像素一致（#62） | `python scripts/probe/capture_pin.py target/release/kinshoko.exe` | | | |
| 贴边隐藏、交还焦点、碰细边滑出（不改原生窗口、收起时点击穿过）、翻转旋转、重开恢复（#63、#64） | `python scripts/probe/edge_restore.py target/release/kinshoko.exe` | | | |
| 钉图滚轮缩放不抽搐、不裁切、无空洞：按显示器刷新率录屏逐帧判定，0 个问题帧（#193、#209） | `python scripts/probe/pin_zoom.py target/release/kinshoko.exe` | | | |

非整数缩放（125%、150%）下钉图不被重新采样：前两个脚本的像素比较都要通过。滑出后的钉图停在伸出屏幕的窗口里、带整数物理像素的平移（#64），`edge_restore.py` 的“指针碰细边时滑出”逐像素比较覆盖这一点。`pin_zoom.py` 需要 numpy 和 PATH 里的 ffmpeg，录像只留在它打印出的临时目录里，不放进仓库、不上传。
