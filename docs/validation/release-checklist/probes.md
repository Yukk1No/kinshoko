# 开发机：模拟键鼠检查

在开发机上用发布构建（`target/release/kinshoko.exe`）运行，运行期间不要碰键鼠，也不能有别的 Kinshoko 或占用 F1/F3/F4 的程序（例如 Snipaste）在运行。

| 检查 | 命令 | 100% | 125% | 150% |
|---|---|---|---|---|
| 截图钉图逐像素一致（#62） | `python scripts/probe/capture_pin.py target/release/kinshoko.exe` | | | |
| 贴边隐藏、交还焦点、碰细边滑出（不改原生窗口、收起时点击穿过）、翻转旋转、重开恢复（#63、#64） | `python scripts/probe/edge_restore.py target/release/kinshoko.exe` | | | |

非整数缩放（125%、150%）下钉图不被重新采样：两个脚本的像素比较都要通过。滑出后的钉图停在伸出屏幕的窗口里、带整数物理像素的平移（#64），`edge_restore.py` 的“指针碰细边时滑出”逐像素比较覆盖这一点。
