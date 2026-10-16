"""Zip the built prototype for the artist: open index.html with a double click, no install.

Usage: npm run pack   (builds first, then writes reference-browser-<commit>.zip here)
The zip holds sample images that may not be redistributed: hand it over privately, never attach it to GitHub.
"""
import os, subprocess, zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(HERE, "dist")
try:
    rev = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=HERE, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--", "."], cwd=HERE, text=True).strip())
except Exception:
    rev, dirty = "local", False
name = f"reference-browser-{rev}{'-dirty' if dirty else ''}"
GUIDE = """Kinshoko 参考浏览样稿（#13）

1. 解压整个文件夹，双击 index.html（用 Edge 或 Chrome 打开）。不需要安装任何东西，不联网。
2. 试一遍：找一处局部 → 钉住 → 再找一张 → 存成参考组 → 关掉浏览器再打开 → 打开刚才的参考组。
   - 输入“蓝发”“双马尾”，或点上方“发色”“发型”里的标签；
   - 单击图片查看，按 F1 框出局部，点“钉住局部”或按 Enter；Esc 关闭刚钉住的图，再按一次回到图片墙；
   - 复制一张网上的图，回到页面按 Ctrl+V，可以把它当作截图钉住；
   - 钉图上右键可以翻转、旋转、调透明度、锁定；F4 把钉图全部收到屏幕边。
3. 设置里可以打开“记录使用日志”（默认关闭）。日志只存在这台电脑的浏览器里，需要时点“导出日志”把文件发回来。
4. 有别扭的地方，记下“当时想做什么、实际发生了什么”。

整理、参考组和钉图会保存在浏览器里；截图与拖进来的图片关掉就没了。
"""
out = os.path.join(HERE, name + ".zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for root, _, files in os.walk(DIST):
        for f in files:
            path = os.path.join(root, f)
            z.write(path, os.path.join(name, os.path.relpath(path, DIST)))
    z.writestr(os.path.join(name, "试用说明.txt"), GUIDE)
print(out, f"{os.path.getsize(out) / 1e6:.0f} MB")
