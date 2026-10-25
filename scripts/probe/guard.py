"""模拟键鼠探针共用的守卫：前台检查、输入锁与隔离启动（#209）。

- 前台检查：前台是别的全屏程序（游戏、演示、全屏视频）时拒绝注入输入并立即退出。
  带反作弊的游戏会拦截合成输入，也不该被脚本打扰；不等待，也不在它退出后自动开跑。
- 输入锁：`%LOCALAPPDATA%\\kinshoko-probe\\input.lock`。持有它的探针独占鼠标键盘，
  别的探针或会话拿不到就立即退出。锁由系统在进程结束时释放，进程崩溃也不会留下死锁。
- 隔离启动：探针要求用 `tauri.probe.json` 换掉 identifier 的构建，数据放在临时目录，
  全局快捷键改成 F13～F15。这样单实例插件不会把启动交给已安装、正在运行的 Kinshoko，
  也不会与它抢 F1/F3/F4。构建命令：

      npx tauri build --no-bundle --config scripts/probe/tauri.probe.json
"""

import ctypes
import json
import msvcrt
import os
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from ctypes import wintypes
from pathlib import Path

# 输出重定向到文件或管道时也用 UTF-8（默认按系统代码页，打不出 ✓ ✗）。
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
user32 = ctypes.windll.user32
# 物理像素坐标（每显示器 DPI 感知 v2），与 Kinshoko 一致。
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

IDENTIFIER = json.loads((Path(__file__).parent / "tauri.probe.json").read_text("utf-8"))["identifier"]
# 探针构建的全局快捷键：一般键盘没有 F13～F15，不会与已安装的 Kinshoko 或 Snipaste 冲突。
VK_CAPTURE, VK_PIN_CLIPBOARD, VK_HIDE_ALL = 0x7C, 0x7D, 0x7E
SHORTCUTS = {"capture": "F13", "pinClipboard": "F14", "hideAllPins": "F15"}
LOCK = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "kinshoko-probe" / "input.lock"

# SHQueryUserNotificationState：系统认为有全屏程序在前台时的几种状态。
QUNS_FULLSCREEN = {2: "全屏程序（QUNS_BUSY）", 3: "全屏 Direct3D 程序", 4: "演示模式"}


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


def window_title(hwnd):
    text = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, text, 256)
    return text.value


def fullscreen_foreground(ignore=()):
    """前台是别的全屏程序时返回说明，否则返回 None。

    `ignore` 是探针自己启动的进程：运行中只看前台窗口，不问系统通知状态，免得把被测的
    Kinshoko（钉图层几乎盖满显示器）当成别的全屏程序。
    """
    if not ignore:
        state = ctypes.c_int()
        if ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state)) == 0:
            if state.value in QUNS_FULLSCREEN:
                return QUNS_FULLSCREEN[state.value]
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value == os.getpid() or pid.value in ignore:
        return None
    cls = ctypes.create_unicode_buffer(64)
    user32.GetClassNameW(hwnd, cls, 64)
    if cls.value in ("Progman", "WorkerW", "Shell_TrayWnd"):  # 桌面与任务栏
        return None
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
    user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(info))
    m = info.rcMonitor
    if r.left <= m.left and r.top <= m.top and r.right >= m.right and r.bottom >= m.bottom:
        return f"盖满整个显示器的窗口「{window_title(hwnd)}」（进程 {pid.value}）"
    return None


def check_foreground(ignore=()):
    problem = fullscreen_foreground(ignore)
    if problem:
        raise SystemExit(f"前台是{problem}：不注入键鼠输入，退出。等它关掉后再手动运行探针。")


@contextmanager
def input_lock(name):
    """独占鼠标键盘；锁被占用时立即退出并说明是谁占着。"""
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    owner = LOCK.with_suffix(".owner")
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT)
    try:
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError:
        os.close(fd)
        who = owner.read_text("utf-8") if owner.exists() else "未知进程"
        raise SystemExit(f"输入锁被占用（{who}），别的探针或会话正在用鼠标键盘，退出。锁文件：{LOCK}")
    try:
        owner.write_text(f"{name}，进程 {os.getpid()}", "utf-8")
        yield
    finally:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        os.close(fd)


@contextmanager
def take_input(name):
    """探针的入口：先检查前台，再拿输入锁。"""
    check_foreground()
    with input_lock(name):
        yield


def find_window(pid, title):
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and window_title(hwnd) == title:
            found.append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    return found[0] if found else None


def data_dir(settings=None, path=None):
    """数据目录（默认新建临时目录），写好探针用的设置（快捷键改成 F13～F15）。"""
    data = Path(path) if path else Path(tempfile.mkdtemp(prefix="kinshoko-probe-"))
    data.mkdir(parents=True, exist_ok=True)
    (data / "settings.json").write_text(
        json.dumps({"shortcuts": SHORTCUTS, **(settings or {})}), "utf-8"
    )
    return data


def launch(exe, data, pump=lambda: None):
    """隔离启动探针构建；等单实例窗口出现、全局快捷键注册完再返回。"""
    env = dict(os.environ, KINSHOKO_DATA_DIR=str(data), KINSHOKO_SKIP_AUTOSTART="1")
    app = subprocess.Popen([str(exe), "--autostart"], env=env)
    end = time.time() + 20
    while time.time() < end:
        if find_window(app.pid, f"{IDENTIFIER}-siw"):
            break
        if find_window(app.pid, "dev.kinshoko-siw") or app.poll() is not None:
            app.kill()
            sys.exit(
                f"{exe} 不是探针构建（identifier 不是 {IDENTIFIER}），或者启动被交给了已安装的 Kinshoko。"
                "先用 `npx tauri build --no-bundle --config scripts/probe/tauri.probe.json` 构建。"
            )
        pump()
        time.sleep(0.05)
    else:
        app.kill()
        sys.exit("等待超时：应用启动")
    end = time.time() + 1.5
    while time.time() < end:
        pump()
        time.sleep(0.02)
    return app
