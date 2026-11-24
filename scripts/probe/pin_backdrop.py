"""钉图背后的程序照常绘制、不触发全屏判定（#275、#277、#287）。

用模拟键鼠在真机上走一遍：最大化一个测试用 Edge（独立配置目录，`--disable-extensions --disable-sync`，
页面每帧动一下），在它前面用剪贴板钉图（F3）钉 1 张、8 张，把一张滚轮放大到盖满屏幕，滚轮缩放中、
F1 框选中、钉图菜单开着时，再把 Edge 切成全屏（F11），最后把 Kinshoko 主窗口最大化放到钉图背后。
每一步经 CDP 读背后页面的 `visibilityState` 与 1 秒内 rAF 次数，并查 `SHQueryUserNotificationState`。

通过：背后页面始终 `visible`、rAF 不低于没有钉图时的 90%；钉图盖满屏幕时 QUNS 不是 BUSY（Edge 自己
全屏那一步 Windows 本来就报忙碌，只记录）；前台始终是背后那个程序（钉图不抢前台；菜单与 F1 框选窗口
开着时前台是它们，只记录）。

用法：python scripts/probe/pin_backdrop.py target/release/kinshoko.exe
要 Pillow 与 Node（读 CDP）。运行期间会移动鼠标、按键、弹出最大化的 Edge，请不要碰键鼠；不能有别的
Kinshoko 或占用 F1/F3 的程序在运行。数据放在临时目录，不碰本机设置、资料库与平时用的 Edge。
"""

import ctypes
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capture_pin import (  # noqa: E402
    PIN_TITLE,
    key,
    move,
    pause,
    probe_data,
    running,
    started,
    wait_for,
    window_rect,
)

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
shell32 = ctypes.windll.shell32
for f, res, args in [
    (kernel32.GlobalAlloc, ctypes.c_void_p, [wintypes.UINT, ctypes.c_size_t]),
    (kernel32.GlobalLock, ctypes.c_void_p, [ctypes.c_void_p]),
    (kernel32.GlobalUnlock, wintypes.BOOL, [ctypes.c_void_p]),
    (user32.SetClipboardData, ctypes.c_void_p, [wintypes.UINT, ctypes.c_void_p]),
    (user32.SetForegroundWindow, wintypes.BOOL, [wintypes.HWND]),
    (user32.ShowWindow, wintypes.BOOL, [wintypes.HWND, ctypes.c_int]),
]:
    f.restype, f.argtypes = res, args

VK_F1, VK_F3, VK_F11, VK_ESCAPE, VK_MENU = 0x70, 0x72, 0x7A, 0x1B, 0x12
WHEEL, RIGHTDOWN, RIGHTUP = 0x0800, 0x0008, 0x0010
QUNS = {1: "NOT_PRESENT", 2: "BUSY", 3: "RUNNING_D3D_FULL_SCREEN", 4: "PRESENTATION_MODE",
        5: "ACCEPTS_NOTIFICATIONS", 6: "QUIET_TIME", 7: "APP"}
EDGE = Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe"
EDGE_PORT, APP_PORT = 9339, 9340
EDGE_TITLE = "kinshoko-backdrop"
PAGE = (f"data:text/html,<title>{EDGE_TITLE}</title><body style='margin:0'><div id=b style='width:200px;height:200px;"
        "background:%23c33;position:absolute'></div><script>let t=0;function f(){t++;b.style.left=(t%25600)/10+'px';"
        "requestAnimationFrame(f)}f()</script></body>")
FRAMES = Path(__file__).resolve().parent / "page_frames.mjs"


def put_png(image):
    """把图以注册格式 `PNG` 放进剪贴板（应用读剪贴板用的 arboard 认得它）。"""
    buf = io.BytesIO()
    image.save(buf, "PNG")
    data = buf.getvalue()
    h = kernel32.GlobalAlloc(0x0002, len(data))
    ctypes.memmove(kernel32.GlobalLock(h), data, len(data))
    kernel32.GlobalUnlock(h)
    wait_for("剪贴板", lambda: user32.OpenClipboard(None))
    user32.EmptyClipboard()
    user32.SetClipboardData(user32.RegisterClipboardFormatW("PNG"), h)
    user32.CloseClipboard()


def test_image():
    """400×600：灰底、彩色横条，四周品红边框。"""
    im = Image.new("RGB", (400, 600), (128, 128, 128))
    for i, c in enumerate([(220, 40, 40), (40, 180, 60), (40, 80, 220), (230, 200, 30)]):
        im.paste(c, (40, 60 + i * 120, 360, 140 + i * 120))
    im.paste((255, 0, 255), (0, 0, 400, 20))
    im.paste((255, 0, 255), (0, 580, 400, 600))
    im.paste((255, 0, 255), (0, 0, 20, 600))
    im.paste((255, 0, 255), (380, 0, 400, 600))
    return im


def windows(pid=None, title=None, prefix=None):
    """可见顶层窗口：(hwnd, 外框)。"""
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        text = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, text, 256)
        if (user32.IsWindowVisible(hwnd) and (pid is None or owner.value == pid)
                and (title is None or text.value == title) and (prefix is None or text.value.startswith(prefix))):
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append((hwnd, (r.left, r.top, r.right, r.bottom)))
        return True

    user32.EnumWindows(visit, 0)
    return found


def bring_front(hwnd):
    # 按一下 Alt 才允许把别的进程的窗口放到前台。
    user32.keybd_event(VK_MENU, 0, 0, 0)
    user32.SetForegroundWindow(hwnd)
    user32.keybd_event(VK_MENU, 0, 0x0002, 0)
    pause(0.5)


def foreground():
    return user32.GetForegroundWindow()


def quns():
    state = ctypes.c_int()
    shell32.SHQueryUserNotificationState(ctypes.byref(state))
    return QUNS.get(state.value, str(state.value))


def frames(port, prefix, exclude=None):
    args = ["node", str(FRAMES), str(port), prefix] + ([exclude] if exclude else [])
    out = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", timeout=20)
    if out.returncode != 0:
        return {"visibility": "找不到页面", "frames": 0, "error": out.stderr.strip()}
    return json.loads(out.stdout)


def wheel(at, notches):
    move(*at)
    for _ in range(abs(notches)):
        user32.mouse_event(WHEEL, 0, 0, 120 if notches > 0 else -120, 0)
        time.sleep(0.03)


def main():
    exe = Path(sys.argv[1]).resolve()
    if running(exe.name):
        raise SystemExit("已有 Kinshoko 在运行（单实例，且占着 F1/F3），先退出它")
    data = probe_data()
    profile = Path(tempfile.mkdtemp(prefix="kinshoko-edge-"))
    env = dict(os.environ, KINSHOKO_DATA_DIR=str(data), KINSHOKO_SKIP_AUTOSTART="1",
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f"--remote-debugging-port={APP_PORT}")
    edge = subprocess.Popen([str(EDGE), f"--user-data-dir={profile}", f"--remote-debugging-port={EDGE_PORT}",
                             "--start-maximized", "--no-first-run", "--no-default-browser-check",
                             "--disable-extensions", "--disable-sync",
                             "--disable-features=msImplicitSignin,msEdgeSyncConsent", PAGE])
    app = subprocess.Popen([str(exe), "--autostart"], env=env)
    rows = []
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    try:
        wait_for("应用启动", lambda: started(app.pid), timeout=20)
        edge_win = wait_for("Edge 窗口", lambda: windows(prefix=EDGE_TITLE), timeout=20)[0][0]
        pause(3)
        bring_front(edge_win)
        put_png(test_image())

        def measure(scene, port=EDGE_PORT, prefix="data:", exclude=None, back=None, gate_quns=True, gate_front=True,
                    setup=None):
            v = frames(port, prefix, exclude)
            rows.append({"scene": scene, **v, "quns": quns(), "front": foreground() == (back or edge_win),
                         "pins": len(windows(app.pid, PIN_TITLE)), "gate_quns": gate_quns, "gate_front": gate_front,
                         "setup": setup})
            r = rows[-1]
            print(f"{scene}\t{r['visibility']}\trAF {r['frames']}\tQUNS {r['quns']}\t前台不变 {r['front']}"
                  f"\t钉图 {r['pins']}", flush=True)

        measure("没有钉图")
        move(sw // 2, sh // 2)
        key(VK_F3)
        wait_for("钉图", lambda: window_rect(app.pid, PIN_TITLE))
        pause(1.5)
        measure("1 张钉图")
        for i in range(7):
            move(200 + i * 250, 200 + (i % 2) * 400)
            key(VK_F3)
            pause(0.6)
        wait_for("8 张钉图", lambda: len(windows(app.pid, PIN_TITLE)) >= 8, timeout=15)
        pause(1.5)
        measure("8 张钉图")

        # 最后钉的那张（光标下）一路放大到盖满屏幕；放大过程中量一次。
        hwnd, r = windows(app.pid, PIN_TITLE)[0]
        centre = ((r[0] + r[2]) // 2, (r[1] + r[3]) // 2)
        wheel(centre, 6)
        measure("滚轮缩放中（换窗）")
        for _ in range(40):
            covered = [w for _, w in windows(app.pid, PIN_TITLE) if w[2] - w[0] >= sw and w[3] - w[1] >= sh - 1]
            if covered:
                break
            wheel(centre, 3)
            pause(0.4)
        pause(1.0)
        covered = [w for _, w in windows(app.pid, PIN_TITLE) if w[2] - w[0] >= sw and w[3] - w[1] >= sh - 1]
        print(f"盖满屏幕的钉图窗口：{covered}（屏幕 {sw}×{sh}，应让出一行）")
        # 没放大到盖满屏幕时这一项没测到全屏判定，不能算通过。
        measure("一张盖满屏幕（让出一行）＋7 张", setup=None if covered else "没有钉图盖满屏幕")

        user32.mouse_event(RIGHTDOWN, 0, 0, 0, 0)
        user32.mouse_event(RIGHTUP, 0, 0, 0, 0)
        wait_for("钉图菜单", lambda: windows(app.pid, "Kinshoko 菜单"), timeout=5)
        pause(1.0)
        measure("钉图菜单开着", gate_front=False)
        key(VK_ESCAPE)
        pause(1.0)
        bring_front(edge_win)

        key(VK_F1)
        wait_for("框选窗口", lambda: window_rect(app.pid, "Kinshoko 截图"))
        pause(1.0)
        measure("F1 框选中", gate_front=False)
        key(VK_ESCAPE)
        pause(1.0)
        bring_front(edge_win)
        measure("F1 收起后")

        key(VK_F11)
        pause(2.5)
        measure("Edge 全屏（F11）", gate_quns=False)
        key(VK_F11)
        pause(2.0)

        # 主窗口：再启动一次（单实例）把它叫出来，最大化放到钉图背后。
        subprocess.Popen([str(exe)], env=env)
        main_win = wait_for("主窗口", lambda: windows(app.pid, "Kinshoko"), timeout=15)[0][0]
        # 不用 bring_front：再启动时主窗口已到前台；对 WebView 窗口按 Alt 会进系统菜单模式，CDP 就不回了。
        user32.ShowWindow(main_win, 3)
        pause(2.0)
        measure("Kinshoko 主窗口最大化在钉图背后", APP_PORT, "http://tauri.localhost/", "view=", back=main_win)
    finally:
        app.kill()
        edge.kill()
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(edge.pid)], capture_output=True)
        pause(1.0)
        shutil.rmtree(profile, ignore_errors=True)

    base = rows[0]["frames"]
    failed = 0
    for r in rows:
        problems = [r["setup"]] if r["setup"] else []
        if r["visibility"] != "visible":
            problems.append(f"visibilityState={r['visibility']}")
        if r["frames"] < 0.9 * base:
            problems.append(f"rAF {r['frames']} < 没有钉图时 {base} 的 90%")
        if r["gate_quns"] and r["quns"] == "BUSY":
            problems.append("QUNS_BUSY")
        if r["gate_front"] and not r["front"]:
            problems.append("前台变了")
        failed += bool(problems)
        print(("✗ " if problems else "✓ ") + r["scene"] + (f"：{'，'.join(problems)}" if problems else ""))
    scale = ctypes.windll.shcore.GetScaleFactorForDevice(0)
    print(f"屏幕 {sw}×{sh}，显示缩放 {scale}%，数据目录 {data}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
