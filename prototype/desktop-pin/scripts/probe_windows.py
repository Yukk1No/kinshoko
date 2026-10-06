"""PROTOTYPE: objective dev-machine checks for the desktop pin probe (#7, round 2).

Drives the real flow with synthesized input (it moves your mouse for ~20 s):
  1. F1 -> drag a region -> Enter: a pin appears exactly over the region, pixels unchanged;
  2. the capture lands in history;
  3. F4 with the pin focused: pin slides to the nearest edge leaving a sliver,
     and the keyboard goes back to the previously used app (a throwaway Tk window here);
  4. hovering the sliver slides that pin out, leaving slides it back; F4 again returns it home;
  5. H flips horizontally (screen equals mirrored capture); R rotates (window w/h swap);
  6. restart restores position, flip and rotation, shown (not hidden).
Run after `npm run build`:  python scripts/probe_windows.py
WARNING: wipes the prototype's state file and capture history.
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageGrab, ImageOps

user32 = ctypes.windll.user32
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # physical coordinates

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "src-tauri" / "target" / "release" / "kinshoko-desktop-pin-prototype.exe"
DATA = Path(os.environ["APPDATA"]) / "dev.kinshoko.prototype.desktoppin"
STATE = DATA / "PROTOTYPE-state-wipe-me.json"
VK = {"F1": 0x70, "F4": 0x73, "ENTER": 0x0D, "H": 0x48, "R": 0x52}
SLIVER = 6

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


def windows_of(pid, title):
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, buf, 256)
            if buf.value == title:
                found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found


def rect(hwnd):
    r = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(r))
    pt = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return (pt.x, pt.y, pt.x + r.right, pt.y + r.bottom)


def key(name):
    user32.keybd_event(VK[name], 0, 0, 0)
    time.sleep(0.03)
    user32.keybd_event(VK[name], 0, 2, 0)


def mouse_to(x, y):
    user32.SetCursorPos(x, y)


def glide(a, b, steps=15):
    for i in range(1, steps + 1):
        mouse_to(a[0] + (b[0] - a[0]) * i // steps, a[1] + (b[1] - a[1]) * i // steps)
        time.sleep(0.015)


def drag(a, b):
    glide((a[0] - 60, a[1] - 60), a)  # arrive like a real hand, not a teleport
    time.sleep(0.15)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # left down
    for i in range(1, 11):
        mouse_to(a[0] + (b[0] - a[0]) * i // 10, a[1] + (b[1] - a[1]) * i // 10)
        time.sleep(0.02)
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # left up


def click(x, y):
    mouse_to(x, y)
    time.sleep(0.05)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def wait_for(fn, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.1)
    return None


def same(a, b, tol=6):
    if a.size != b.size:
        return False, f"size {a.size} vs {b.size}"
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    bad = sum(1 for p in diff.getdata() if max(p) > tol)
    return bad <= a.size[0] * a.size[1] * 0.002, f"{bad} px differ"


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("rc", wt.RECT), ("work", wt.RECT), ("f", wt.DWORD)]


def monitor_of(r):
    hmon = user32.MonitorFromPoint(wt.POINT((r[0] + r[2]) // 2, (r[1] + r[3]) // 2), 2)
    mi = MONITORINFO()
    mi.cb = ctypes.sizeof(mi)
    user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
    return (mi.rc.left, mi.rc.top, mi.rc.right, mi.rc.bottom)


def visible_part(r, m):
    w = min(r[2], m[2]) - max(r[0], m[0])
    h = min(r[3], m[3]) - max(r[1], m[1])
    return max(0, w), max(0, h)


def main():
    if not EXE.exists():
        sys.exit("build first: npm run build")
    subprocess.run(["taskkill", "/F", "/IM", EXE.name], capture_output=True)
    STATE.unlink(missing_ok=True)
    shutil.rmtree(DATA / "PROTOTYPE-captures", ignore_errors=True)

    # Stand-in for the painting app: a static window this script owns.
    notepad = subprocess.Popen([sys.executable, "-c", (
        "import tkinter as t; r=t.Tk(); r.title('probe-external'); r.geometry('900x600+300+200');"
        "c=t.Canvas(r,bg='#e8e2d6'); c.pack(fill='both',expand=1);"
        "[c.create_line(0,i,900,600-i,fill='#553',width=1) for i in range(0,600,7)]; r.mainloop()")])
    time.sleep(2.0)
    proc = subprocess.Popen([str(EXE)], stderr=open(ROOT / "scripts" / "probe-app.log", "w", encoding="utf-8"))
    main_win = wait_for(lambda: windows_of(proc.pid, "Kinshoko 钉图原型（PROTOTYPE）"))
    if main_win:
        user32.ShowWindow(main_win[0], 6)  # minimise the control window: capture something else
    np_hwnd = user32.FindWindowW(None, "probe-external")
    user32.SetForegroundWindow(np_hwnd)
    time.sleep(0.8)

    # ---- 1. capture
    R = (420, 260, 740, 470)
    mouse_to(5, 5)
    time.sleep(0.3)
    B = (R[0] - 40, R[1] - 40, R[2] + 40, R[3] + 40)
    before_big = ImageGrab.grab(bbox=B, all_screens=True)
    t0 = time.time()
    key("F1")
    cap = wait_for(lambda: windows_of(proc.pid, "截图"))
    check("F1 opens the frozen-screen overlay", bool(cap), f"{time.time() - t0:.2f}s")
    time.sleep(0.4)
    drag((R[0], R[1]), (R[2], R[3]))
    time.sleep(0.2)
    key("ENTER")
    pins = wait_for(lambda: windows_of(proc.pid, "钉图"))
    check("Enter pins the region", bool(pins))
    if not pins:
        return finish(proc, notepad)
    pin = pins[0]
    time.sleep(0.6)
    P = rect(pin)
    check("pin sits over the dragged region (±1 px)", all(abs(a - b) <= 1 for a, b in zip(P, R)), f"{P} vs {R}")
    R = P  # later checks follow the pin wherever it actually is
    before = before_big.crop((R[0] - B[0], R[1] - B[1], R[2] - B[0], R[3] - B[1]))
    mouse_to(5, 5)
    time.sleep(0.4)
    state = json.loads(STATE.read_text(encoding="utf-8"))
    captured = Image.open(state["history"][0]["file"]).convert("RGB")
    ok, d = same(captured, before)
    check("capture equals the screen before F1", ok, d)
    shown = ImageGrab.grab(bbox=R, all_screens=True)
    ok, d = same(shown, captured)
    if not ok:
        shown.save(ROOT / "scripts" / "probe-shown.png")
        captured.save(ROOT / "scripts" / "probe-captured.png")
    check("pin shows the captured pixels unchanged", ok, d)
    before = captured
    check("capture recorded in history", len(state["history"]) == 1 and Path(state["history"][0]["file"]).exists())

    # ---- 3. hide to edge, focus back to Notepad
    user32.SetForegroundWindow(np_hwnd)
    time.sleep(0.3)
    click((R[0] + R[2]) // 2, (R[1] + R[3]) // 2)  # focus the pin
    time.sleep(0.4)
    fg_ours = user32.GetForegroundWindow() == pin
    mouse_to(5, 900)
    key("F4")
    time.sleep(0.6)
    hr = rect(pin)
    m = monitor_of(R)
    vw, vh = visible_part(hr, m)
    check("F4 slides pin to the edge, sliver visible", min(vw, vh) == SLIVER, f"rect {hr}, visible {vw}x{vh}")
    check("F4 hands the keyboard back to the external app", user32.GetForegroundWindow() == np_hwnd, f"(pin had focus: {fg_ours})")

    # ---- 4. peek
    sx = max(hr[0], m[0]) + 2
    sy = max(hr[1], m[1]) + min(vh, hr[3] - hr[1]) // 2
    mouse_to(sx, sy)
    time.sleep(0.6)
    pr = rect(pin)
    pw, ph = visible_part(pr, m)
    check("hovering the sliver slides the pin out", (pw, ph) == (R[2] - R[0], R[3] - R[1]), f"rect {pr}")
    mouse_to(m[0] + (m[2] - m[0]) // 2, m[3] - 5)
    time.sleep(0.6)
    check("leaving slides it back to the sliver", rect(pin) == hr, f"{rect(pin)}")
    key("F4")
    time.sleep(0.6)
    check("F4 again returns the pin home", rect(pin) == R, f"{rect(pin)}")

    # ---- 5. flip / rotate
    click((R[0] + R[2]) // 2, (R[1] + R[3]) // 2)
    time.sleep(0.3)
    key("H")
    mouse_to(5, 5)
    time.sleep(0.5)
    ok, d = same(ImageGrab.grab(bbox=R, all_screens=True), ImageOps.mirror(before))
    check("H flips the pin horizontally", ok, d)
    click((R[0] + R[2]) // 2, (R[1] + R[3]) // 2)
    time.sleep(0.3)
    key("R")
    time.sleep(0.6)
    rr = rect(pin)
    check("R rotates 90° (window w/h swap)", (rr[2] - rr[0], rr[3] - rr[1]) == (R[3] - R[1], R[2] - R[0]), f"{rr}")

    # ---- 6. restart
    proc.kill()
    proc.wait()
    proc = subprocess.Popen([str(EXE)])
    again = wait_for(lambda: windows_of(proc.pid, "钉图"))
    time.sleep(1.0)
    saved = json.loads(STATE.read_text(encoding="utf-8"))["pins"][0]
    check(
        "restart restores pin with flip + rotation",
        bool(again) and rect(again[0]) == rr and saved["flipH"] and saved["rotation"] == 1,
        f"{rect(again[0]) if again else None}",
    )
    finish(proc, notepad)


def finish(proc, notepad):
    proc.kill()
    notepad.kill()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
