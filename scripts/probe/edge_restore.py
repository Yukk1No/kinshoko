"""贴边隐藏、交还焦点与钉图状态恢复的检查（#63，移植 #7 原型 probe_windows.py 的后半）。

用模拟键鼠在真机上走一遍：截图钉住一块逐像素随机的测试图 → 点一下“外部绘画软件”（一个普通
Tk 窗口）再点钉图 → F4 贴边隐藏 → 检查只露细边、焦点回到外部窗口 → 指针碰细边滑出、离开收回 →
再按 F4 回到原位 → H 翻转、R 旋转（屏幕像素与截图的镜像／旋转一致）→ 结束进程再启动，
检查钉图的位置、翻转与旋转都恢复。

用法：python scripts/probe/edge_restore.py target/release/kinshoko.exe
需要 Pillow。运行期间会移动鼠标、按 F1/F4/H/R，请不要碰键鼠；不能有别的 Kinshoko 或占用
F1/F4 的程序（例如 Snipaste）在运行。数据放在临时目录，不碰本机设置与资料库。
验收要求在 100%、125% 与 150% 缩放下各跑一次。
"""

import ctypes
import os
import subprocess
import sys
import tempfile
import time
import tkinter as tk
from pathlib import Path

from PIL import Image, ImageTk

sys.path.insert(0, str(Path(__file__).parent))
from capture_pin import (  # noqa: E402
    LEFTDOWN,
    LEFTUP,
    PATTERN,
    PUMP,
    diff,
    grab,
    key,
    move,
    pause,
    running,
    user32,
    wait_for,
    window_rect,
)

VK_F1, VK_F4, VK_H, VK_R = 0x70, 0x73, 0x48, 0x52
SLIVER = 6


def click(x, y):
    move(x, y)
    user32.mouse_event(LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.03)
    user32.mouse_event(LEFTUP, 0, 0, 0, 0)
    pause(0.2)


def launch(exe, env):
    app = subprocess.Popen([str(exe), "--autostart"], env=env)
    wait_for("应用启动", lambda: window_rect(app.pid, "dev.kinshoko-siw"), timeout=20)
    pause(1.5)
    return app


def foreground_pid():
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), ctypes.byref(pid))
    return pid.value


def screen_rect():
    """主显示器的物理像素矩形（测试图和钉图都在主显示器上）。"""
    return (0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))


def visible_part(rect, screen):
    l, t, r, b = rect
    sl, st, sr, sb = screen
    return (max(l, sl), max(t, st), min(r, sr), min(b, sb))


def main():
    exe = Path(sys.argv[1]).resolve()
    data = Path(tempfile.mkdtemp(prefix="kinshoko-probe-"))
    env = dict(os.environ, KINSHOKO_DATA_DIR=str(data), KINSHOKO_SKIP_AUTOSTART="1")
    if running(exe.name):
        raise SystemExit("已有 Kinshoko 在运行（单实例），先退出它")
    app = launch(exe, env)

    # “外部绘画软件”：一个普通的、能拿到焦点的窗口，里面显示逐像素随机的测试图。
    import random

    random.seed(63)
    pattern = Image.new("RGB", PATTERN)
    pattern.putdata([tuple(random.randrange(256) for _ in range(3)) for _ in range(PATTERN[0] * PATTERN[1])])
    root = tk.Tk()
    root.title("外部绘画软件")
    root.geometry(f"{PATTERN[0] + 200}x{PATTERN[1] + 200}+400+300")
    photo = ImageTk.PhotoImage(pattern)
    tk.Label(root, image=photo, borderwidth=0, highlightthickness=0).place(x=0, y=0)
    root.update()
    PUMP.append(root.update)
    pause(2.0)
    ox, oy = root.winfo_rootx(), root.winfo_rooty()
    results = {}
    screen = screen_rect()

    try:
        x0, y0, x1, y1 = ox + 17, oy + 11, ox + 17 + 151, oy + 11 + 97
        before = grab((x0, y0, x1, y1))
        move(ox + 5, oy + 5)
        key(VK_F1)
        wait_for("框选窗口", lambda: window_rect(app.pid, "Kinshoko 截图"))
        pause(0.3)
        move(x0, y0)
        user32.mouse_event(LEFTDOWN, 0, 0, 0, 0)
        for t in range(1, 11):
            move(x0 + (x1 - x0) * t / 10, y0 + (y1 - y0) * t / 10)
        user32.mouse_event(LEFTUP, 0, 0, 0, 0)
        pause(0.2)
        move((x0 + x1) // 2, (y0 + y1) // 2)
        for _ in range(2):
            user32.mouse_event(LEFTDOWN, 0, 0, 0, 0)
            user32.mouse_event(LEFTUP, 0, 0, 0, 0)
            time.sleep(0.05)
        home = wait_for("钉图窗口", lambda: window_rect(app.pid, "Kinshoko 钉图"))
        pause(1.5)

        # 外部窗口先拿到焦点，再点钉图（钉图拿到焦点），然后 F4。
        click(ox + PATTERN[0] + 100, oy + PATTERN[1] + 100)
        click((home[0] + home[2]) // 2, (home[1] + home[3]) // 2)
        results["点钉图后焦点在 Kinshoko"] = None if foreground_pid() == app.pid else "焦点不在钉图"
        key(VK_F4)
        pause(0.5)
        hidden = window_rect(app.pid, "Kinshoko 钉图")
        part = visible_part(hidden, screen)
        shown_w, shown_h = part[2] - part[0], part[3] - part[1]
        results["F4 后只露 6 像素细边"] = (
            None if min(shown_w, shown_h) == SLIVER else f"露出 {shown_w}×{shown_h}（{hidden}）"
        )
        results["F4 把焦点交还外部窗口"] = (
            None if foreground_pid() == os.getpid() else f"前台进程 {foreground_pid()}"
        )

        # 碰细边滑出，离开收回。
        move((part[0] + part[2]) // 2, (part[1] + part[3]) // 2)
        pause(0.5)
        peek = window_rect(app.pid, "Kinshoko 钉图")
        peek_part = visible_part(peek, screen)
        results["指针碰细边时滑出"] = (
            None
            if (peek[2] - peek[0], peek[3] - peek[1]) == (home[2] - home[0], home[3] - home[1])
            and peek_part == peek
            else f"滑出后 {peek}"
        )
        move(screen[2] // 2, screen[3] // 2)
        pause(0.5)
        results["指针离开后收回"] = (
            None if window_rect(app.pid, "Kinshoko 钉图") == hidden else "没有收回细边"
        )

        key(VK_F4)
        pause(0.5)
        results["再按 F4 回到原位"] = (
            None if window_rect(app.pid, "Kinshoko 钉图") == home else f"回到 {window_rect(app.pid, 'Kinshoko 钉图')}"
        )

        # 翻转、旋转：先点钉图让它拿到焦点。
        click((home[0] + home[2]) // 2, (home[1] + home[3]) // 2)
        move(0, 0)
        key(VK_H)
        pause(0.5)
        flipped = before.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        results["H 翻转后屏幕像素是截图的镜像"] = diff(grab(window_rect(app.pid, "Kinshoko 钉图")), flipped)
        click((home[0] + home[2]) // 2, (home[1] + home[3]) // 2)
        move(0, 0)
        key(VK_R)
        pause(0.5)
        turned = flipped.transpose(Image.Transpose.ROTATE_270)  # 顺时针 90°
        turned_rect = window_rect(app.pid, "Kinshoko 钉图")
        results["R 旋转后宽高互换、像素是截图的旋转"] = diff(grab(turned_rect), turned)

        # 结束进程（不走正常退出）再启动：状态改动后不久就已写回文件。
        pause(1.0)
        app.kill()
        app.wait()
        pause(1.0)
        app = launch(exe, env)
        restored = wait_for("恢复的钉图", lambda: window_rect(app.pid, "Kinshoko 钉图"), timeout=10)
        move(0, 0)
        pause(1.5)
        results["重开后钉图回到原位置"] = None if restored == turned_rect else f"{restored} ≠ {turned_rect}"
        results["重开后翻转与旋转都恢复"] = diff(grab(restored), turned)
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
