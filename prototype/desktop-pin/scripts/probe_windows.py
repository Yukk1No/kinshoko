"""PROTOTYPE: objective dev-machine checks for the desktop pin probe (#7).

What it checks, without a human:
  1. restored pins open at the saved physical position/size;
  2. the pinned crop on screen equals the source pixels exactly at 1:1 (screen capture diff);
  3. pins are TOPMOST; the global exit key toggles WS_EX_TRANSPARENT and hit-testing;
  4. after a restart, position and crop come back, click-through comes back OFF.

It does NOT prove pen input reaches a painting app; that needs the artist's machine.
Run after `npm run build`:  python scripts/probe_windows.py
WARNING: overwrites the prototype's pin file (PROTOTYPE-pins-wipe-me.json).
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageGrab, ImageOps

user32 = ctypes.windll.user32
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # per-monitor v2: physical coordinates

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "src-tauri" / "target" / "release" / "kinshoko-desktop-pin-prototype.exe"
DATA = Path(os.environ["APPDATA"]) / "dev.kinshoko.prototype.desktoppin" / "PROTOTYPE-pins-wipe-me.json"
SAMPLES = ROOT / "public" / "samples"

GWL_EXSTYLE = -20
WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_EX_LAYERED = 0x8, 0x20, 0x80000
VK_CONTROL, VK_MENU, VK_T = 0x11, 0x12, 0x54

PINS = [
    {"id": "probe1", "src": "/samples/pixel-grid.png", "crop": {"x": 0, "y": 0, "w": 480, "h": 360},
     "scale": 1.0, "x": 200, "y": 200, "onTop": True, "locked": False},
    {"id": "probe2", "src": "/samples/line-study.png", "crop": {"x": 300, "y": 150, "w": 420, "h": 300},
     "scale": 1.0, "x": 760, "y": 240, "onTop": True, "locked": True},
    # Stored rotated with EXIF Orientation=6; crop is in oriented (upright) pixels.
    {"id": "probe3", "src": "/samples/exif-orientation-6.jpg", "crop": {"x": 0, "y": 0, "w": 400, "h": 300},
     "scale": 1.0, "x": 200, "y": 620, "onTop": True, "locked": False},
]

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


def pin_windows(pid):
    found = {}

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, buf, 256)
            if buf.value == "钉图":
                found[hwnd] = client_rect(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found


def client_rect(hwnd):
    r = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(r))
    pt = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return (pt.x, pt.y, pt.x + r.right, pt.y + r.bottom)


def exstyle(hwnd):
    return user32.GetWindowLongPtrW(wt.HWND(hwnd), GWL_EXSTYLE)


def hit(x, y):
    h = user32.WindowFromPoint(wt.POINT(x, y))
    return user32.GetAncestor(h, 2)  # GA_ROOT


def press_exit_key():
    for vk in (VK_CONTROL, VK_MENU, VK_T):
        user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.05)
    for vk in (VK_T, VK_MENU, VK_CONTROL):
        user32.keybd_event(vk, 0, 2, 0)
    time.sleep(0.6)


def by_rect(wins, pin):
    for hwnd, r in wins.items():
        if r[0] == pin["x"] and r[1] == pin["y"]:
            return hwnd, r
    return None, None


def launch():
    proc = subprocess.Popen([str(EXE)])
    for _ in range(60):
        time.sleep(0.5)
        wins = pin_windows(proc.pid)
        if len(wins) == len(PINS):
            time.sleep(1.5)  # let the canvas draw
            return proc, pin_windows(proc.pid)
    return proc, pin_windows(proc.pid)


def main():
    if not EXE.exists():
        sys.exit("build first: npm run build")
    subprocess.run(["taskkill", "/F", "/IM", EXE.name], capture_output=True)
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(PINS), encoding="utf-8")
    user32.SetCursorPos(5, 5)  # keep the hover toolbar hidden

    proc, wins = launch()
    check("all pins restored", len(wins) == len(PINS), str(list(wins.values())))
    dpi = user32.GetDpiForWindow(wt.HWND(next(iter(wins)))) if wins else 0
    print(f"     monitor DPI {dpi} ({dpi / 96:.0%})")

    for pin in PINS:
        hwnd, r = by_rect(wins, pin)
        size = (r[2] - r[0], r[3] - r[1]) if r else None
        want = (round(pin["crop"]["w"] * pin["scale"]), round(pin["crop"]["h"] * pin["scale"]))
        check(f"{pin['id']} at saved position, physical size {want}", size == want, f"got {r}")
        if not hwnd:
            continue
        check(f"{pin['id']} topmost", bool(exstyle(hwnd) & WS_EX_TOPMOST))
        shot = ImageGrab.grab(bbox=r, all_screens=True).convert("RGB")
        c = pin["crop"]
        src = ImageOps.exif_transpose(Image.open(SAMPLES / Path(pin["src"]).name)).convert("RGB")
        src = src.crop((c["x"], c["y"], c["x"] + c["w"], c["y"] + c["h"]))
        diff = ImageChops.difference(shot, src)
        tol = 24 if pin["src"].endswith(".jpg") else 2  # JPEG decoders differ slightly
        bad = sum(1 for p in diff.getdata() if max(p) > tol)
        total = c["w"] * c["h"]
        shot.save(ROOT / "scripts" / f"probe-{pin['id']}-screen.png")
        check(f"{pin['id']} 1:1 pixels match source", bad == 0, f"{bad}/{total} differ (>{tol}/255)")

    hwnd1, r1 = by_rect(wins, PINS[0])
    if hwnd1:
        cx, cy = (r1[0] + r1[2]) // 2, (r1[1] + r1[3]) // 2
        check("before: pin receives hit-test", hit(cx, cy) == hwnd1)
        press_exit_key()
        es = exstyle(hwnd1)
        check("global key -> click-through on", bool(es & WS_EX_TRANSPARENT and es & WS_EX_LAYERED), hex(es))
        check("click-through: hit-test passes to window below", hit(cx, cy) != hwnd1)
        press_exit_key()
        check("global key again -> click-through off", not exstyle(hwnd1) & WS_EX_TRANSPARENT, hex(exstyle(hwnd1)))
        check("after exit: pin receives hit-test again", hit(cx, cy) == hwnd1)

    # Lock is an app rule: an external move (Win+arrow, snapping, scripts) is reverted.
    hwnd2, r2 = by_rect(wins, PINS[1])
    if hwnd2:
        user32.SetWindowPos(wt.HWND(hwnd2), None, r2[0] + 60, r2[1] + 40, 0, 0, 0x0001 | 0x0004 | 0x0010)
        time.sleep(0.8)
        check("locked pin reverts external move", client_rect(hwnd2)[:2] == r2[:2], str(client_rect(hwnd2)))
    if hwnd1:
        user32.SetWindowPos(wt.HWND(hwnd1), None, r1[0] + 30, r1[1] + 20, 0, 0, 0x0001 | 0x0004 | 0x0010)
        time.sleep(0.8)
        moved = client_rect(hwnd1)[:2] == (r1[0] + 30, r1[1] + 20)
        saved1 = next(p for p in json.loads(DATA.read_text(encoding="utf-8")) if p["id"] == "probe1")
        check("unlocked pin moves and position is saved", moved and (saved1["x"], saved1["y"]) == (r1[0] + 30, r1[1] + 20))
        PINS[0]["x"], PINS[0]["y"] = r1[0] + 30, r1[1] + 20
        user32.SetCursorPos(5, 5)
        press_exit_key()  # leave click-through ON to prove a restart turns it off

    proc.kill()
    proc.wait()
    saved = json.loads(DATA.read_text(encoding="utf-8"))
    check("saved file keeps crop/locked", [(p["crop"], p["locked"]) for p in saved] == [(p["crop"], p["locked"]) for p in PINS])
    proc, wins = launch()
    for pin in PINS:
        hwnd, r = by_rect(wins, pin)
        check(f"restart: {pin['id']} same place/size", hwnd is not None, str(r))
        if hwnd:
            check(f"restart: {pin['id']} click-through off", not exstyle(hwnd) & WS_EX_TRANSPARENT)
    proc.kill()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
