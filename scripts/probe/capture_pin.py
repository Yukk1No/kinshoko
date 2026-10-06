"""截图钉图的像素检查（#62，沿用 #7 原型 probe_windows.py 的做法）。

用模拟键鼠在真机上走一遍：显示一块逐像素随机的测试图 → 按 F1 → 拖动框选 → 双击钉住，
然后比较三份像素：按 F1 前的屏幕、存进截图历史的截图文件、钉图窗口显示在屏幕上的像素。
SDR 桌面上三者应逐像素一致（未缩放、未翻转旋转）。验收要求在 100% 与 150% 缩放下各跑一次。

用法：python scripts/probe/capture_pin.py target/release/kinshoko.exe
需要 Pillow。运行期间会移动鼠标、按 F1，请不要碰键鼠；不能有别的 Kinshoko 或占用 F1 的程序
（例如 Snipaste）在运行。数据放在临时目录，不碰本机设置与资料库。
"""

import ctypes
import os
import random
import subprocess
import sys
import tempfile
import time
import tkinter as tk
from ctypes import wintypes
from pathlib import Path

from PIL import Image, ImageGrab, ImageTk

user32 = ctypes.windll.user32
# 物理像素坐标（每显示器 DPI 感知 v2），与 Kinshoko 一致。
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

VK_F1 = 0x70
KEYUP = 0x0002
LEFTDOWN, LEFTUP = 0x0002, 0x0004
PATTERN = (240, 160)


def key(vk):
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.03)
    user32.keybd_event(vk, 0, KEYUP, 0)


def move(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.02)


def window_rect(pid, title):
    """进程 `pid` 中标题为 `title` 的可见窗口的外框（物理像素）。"""
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        text = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, text, 256)
        if owner.value == pid and text.value == title and user32.IsWindowVisible(hwnd):
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append((r.left, r.top, r.right, r.bottom))
        return True

    user32.EnumWindows(visit, 0)
    return found[0] if found else None


def running(image):
    out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {image}", "/NH"], capture_output=True, text=True)
    return image.lower() in out.stdout.lower()


def wait_for(what, fn, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    raise SystemExit(f"等待超时：{what}")


def grab(box):
    return ImageGrab.grab(bbox=box, all_screens=True).convert("RGB")


def diff(a, b):
    if a.size != b.size:
        return f"尺寸不同 {a.size} ≠ {b.size}"
    bad = sum(1 for p, q in zip(a.getdata(), b.getdata()) if p != q)
    return None if bad == 0 else f"{bad} 个像素不同"


def main():
    exe = Path(sys.argv[1]).resolve()
    data = Path(tempfile.mkdtemp(prefix="kinshoko-probe-"))
    env = dict(os.environ, KINSHOKO_DATA_DIR=str(data), KINSHOKO_SKIP_AUTOSTART="1")
    if running(exe.name):
        raise SystemExit("已有 Kinshoko 在运行（单实例），先退出它")
    app = subprocess.Popen([str(exe), "--autostart"], env=env)
    # 单实例窗口出现说明应用已启动；再等一会儿让全局快捷键注册完。
    wait_for("应用启动", lambda: window_rect(app.pid, "dev.kinshoko-siw"), timeout=20)
    time.sleep(1.5)

    # 逐像素随机的测试图：任何重新采样或颜色转换都会让像素对不上。
    random.seed(62)
    pattern = Image.new("RGB", PATTERN)
    pattern.putdata([tuple(random.randrange(256) for _ in range(3)) for _ in range(PATTERN[0] * PATTERN[1])])
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.geometry(f"{PATTERN[0]}x{PATTERN[1]}+300+300")
    photo = ImageTk.PhotoImage(pattern)
    tk.Label(root, image=photo, borderwidth=0, highlightthickness=0).pack()
    root.update()
    time.sleep(2.5)
    root.update()
    ox, oy = root.winfo_rootx(), root.winfo_rooty()

    try:
        # 选区：测试图内部一块奇数尺寸的区域。
        x0, y0, x1, y1 = ox + 17, oy + 11, ox + 17 + 151, oy + 11 + 97
        before = grab((x0, y0, x1, y1))
        assert diff(before, pattern.crop((17, 11, 168, 108))) is None, "测试图没有按原像素显示"

        move(ox + 5, oy + 5)
        key(VK_F1)
        wait_for("框选窗口", lambda: window_rect(app.pid, "Kinshoko 截图"))
        time.sleep(0.3)
        move(x0, y0)
        user32.mouse_event(LEFTDOWN, 0, 0, 0, 0)
        for t in range(1, 11):
            move(x0 + (x1 - x0) * t / 10, y0 + (y1 - y0) * t / 10)
        user32.mouse_event(LEFTUP, 0, 0, 0, 0)
        time.sleep(0.2)
        move((x0 + x1) // 2, (y0 + y1) // 2)
        for _ in range(2):
            user32.mouse_event(LEFTDOWN, 0, 0, 0, 0)
            user32.mouse_event(LEFTUP, 0, 0, 0, 0)
            time.sleep(0.05)

        pin = wait_for("钉图窗口", lambda: window_rect(app.pid, "Kinshoko 钉图"))
        move(0, 0)
        time.sleep(1.5)  # 等出现时的描边淡出
        captures = list((data / "captures").glob("*.png"))
        results = {
            "钉图窗口尺寸等于选区": None
            if (pin[2] - pin[0], pin[3] - pin[1]) == before.size
            else f"{pin} 与选区 {before.size} 不同",
            "新钉图略微偏离原位置": None if (pin[0], pin[1]) != (x0, y0) else "与选区完全重合",
            "截图文件与按 F1 前的屏幕一致": diff(Image.open(captures[0]).convert("RGB"), before)
            if len(captures) == 1
            else f"截图历史里有 {len(captures)} 个文件",
            "截图文件内嵌显示器配置文件": None
            if len(captures) == 1 and Image.open(captures[0]).info.get("icc_profile")
            else "没有 iCCP",
            "钉图显示的像素与截图一致": diff(grab(pin), before),
        }
    finally:
        root.destroy()
        app.kill()

    scale = ctypes.windll.shcore.GetScaleFactorForDevice(0)
    print(f"显示缩放 {scale}%")
    failed = 0
    for name, problem in results.items():
        print(("✗ " if problem else "✓ ") + name + (f"：{problem}" if problem else ""))
        failed += bool(problem)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
