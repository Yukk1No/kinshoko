"""Observe and drive the frameless main window of the isolated T20 probe like a user would.

The application is bound by its exact frozen path inside this checkout's owned T20 work
directory and its SHA256; only the one main HWND ("Kinshoko") of that one process is used.

Commands (coordinates are physical screen pixels; this process is per-monitor DPI aware v2):
  state                      the main HWND: visible, iconic, zoomed, window and client rect
  restore                    ShowWindow(SW_RESTORE), as a taskbar click on a minimized window
  foreground                 bring the main HWND to the foreground before real mouse input
  dblclick <x> <y>           move the cursor there and double-click with SendInput
  drag <x> <y> <dx> <dy>     press there, move in steps by (dx, dy), release (SendInput)
  tray-open                  choose 打开 Kinshoko on the real tray menu (same dispatch as tray Quit)
Args: <application> <sha256> <command> [numbers...]
Prints one JSON object.
"""
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

application = Path(sys.argv[1]).resolve()
expected_sha256 = sys.argv[2].lower()
command = sys.argv[3]
numbers = [int(value) for value in sys.argv[4:]]
owned_workspace = Path(__file__).resolve().parents[1]
assert hashlib.sha256(application.read_bytes()).hexdigest() == expected_sha256, "Application bytes differ from the frozen T20 build"
assert application.is_relative_to(owned_workspace / "work" / "e2e") and "spec78-t20" in str(application) and application.parent.name == "frozen-runtime", application
ctypes.WinDLL("user32").SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
u = ctypes.WinDLL("user32", use_last_error=True)
CALLBACK = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
u.EnumWindows.argtypes = [CALLBACK, w.LPARAM]
u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
u.GetWindowThreadProcessId.restype = w.DWORD
u.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.IsWindowVisible.argtypes = [w.HWND]
u.IsIconic.argtypes = [w.HWND]
u.IsZoomed.argtypes = [w.HWND]
u.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
u.GetClientRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
u.ClientToScreen.argtypes = [w.HWND, ctypes.POINTER(w.POINT)]
u.ShowWindow.argtypes = [w.HWND, ctypes.c_int]
u.SetForegroundWindow.argtypes = [w.HWND]
u.GetForegroundWindow.restype = w.HWND
u.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
u.GetCursorPos.argtypes = [ctypes.POINTER(w.POINT)]
u.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
u.SendMessageTimeoutW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM, w.UINT, w.UINT, ctypes.POINTER(ctypes.c_size_t)]
u.GetMenuItemCount.argtypes = [w.HMENU]
u.GetMenuStringW.argtypes = [w.HMENU, w.UINT, w.LPWSTR, ctypes.c_int, w.UINT]
u.GetMenuItemID.argtypes = [w.HMENU, ctypes.c_int]
u.GetMenuItemID.restype = w.UINT
u.GetMenuState.argtypes = [w.HMENU, w.UINT, w.UINT]
u.GetMenuState.restype = w.UINT
u.GetDoubleClickTime.restype = w.UINT


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", w.LONG), ("dy", w.LONG), ("mouseData", w.DWORD), ("dwFlags", w.DWORD), ("time", w.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", w.DWORD), ("u", _U)]


u.SendInput.argtypes = [w.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
LEFTDOWN, LEFTUP = 0x2, 0x4

listed = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T20_EXECUTABLE } | Select-Object -ExpandProperty ProcessId)"], env={**os.environ, "KINSHOKO_T20_EXECUTABLE": str(application)}, creationflags=0x08000000).decode()
pids = json.loads(listed)
assert len(pids) == 1, f"Exactly one owned T20 app required: {pids}"
pid = pids[0]


def windows(class_name=None, title=None):
    found = []

    def visit(hwnd, _):
        owner = w.DWORD()
        thread = u.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid:
            return True
        name = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, name, len(name))
        text = ctypes.create_unicode_buffer(1024)
        u.GetWindowTextW(hwnd, text, len(text))
        if (class_name is None or name.value == class_name) and (title is None or text.value == title):
            found.append({"hwnd": int(hwnd), "thread": thread, "class": name.value, "title": text.value})
        return True
    callback = CALLBACK(visit)
    assert u.EnumWindows(callback, 0)
    return found


main = windows(title="Kinshoko")
assert len(main) <= 1, main
hwnd = w.HWND(main[0]["hwnd"]) if main else None


def state():
    # Closing the main window destroys it (the app stays in the tray, ADR 0004); there is then no main HWND.
    if hwnd is None:
        return {"pid": pid, "hwnd": None, "mainWindow": False, "visible": False, "iconic": False, "zoomed": False,
                "trayIcons": len(windows(class_name="tray_icon_app"))}
    r = w.RECT()
    assert u.GetWindowRect(hwnd, ctypes.byref(r))
    c = w.RECT()
    assert u.GetClientRect(hwnd, ctypes.byref(c))
    origin = w.POINT(0, 0)
    assert u.ClientToScreen(hwnd, ctypes.byref(origin))
    return {
        "pid": pid, "hwnd": main[0]["hwnd"], "mainWindow": True, "visible": bool(u.IsWindowVisible(hwnd)), "iconic": bool(u.IsIconic(hwnd)), "zoomed": bool(u.IsZoomed(hwnd)),
        "rect": {"x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top},
        "client": {"x": origin.x, "y": origin.y, "width": c.right, "height": c.bottom},
        "foreground": int(u.GetForegroundWindow() or 0) == main[0]["hwnd"],
        "trayIcons": len(windows(class_name="tray_icon_app")),
    }


def mouse(flags):
    event = INPUT(type=0)
    event.mi = MOUSEINPUT(0, 0, 0, flags, 0, 0)
    assert u.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT)) == 1, ctypes.get_last_error()


def cursor():
    p = w.POINT()
    assert u.GetCursorPos(ctypes.byref(p))
    return {"x": p.x, "y": p.y}


result = {"command": command, "args": numbers, "before": state()}
assert hwnd is not None or command in ("state", "tray-open"), "No main window for " + command
if command == "state":
    pass
elif command == "restore":
    u.ShowWindow(hwnd, 9)
    time.sleep(0.3)
elif command == "foreground":
    # A foreground change is allowed after this process sends input. Use a zero mouse move, not an Alt
    # tap: Alt on an already active frameless window enters its system-menu loop and stalls the WebView.
    if not result["before"]["foreground"]:
        mouse(0x1)
        u.SetForegroundWindow(hwnd)
        time.sleep(0.3)
elif command == "dblclick":
    x, y = numbers
    assert u.SetCursorPos(x, y)
    time.sleep(0.15)
    result["cursor"] = cursor()
    gap = min(80, u.GetDoubleClickTime() // 4) / 1000
    for _ in range(2):
        mouse(LEFTDOWN)
        time.sleep(0.02)
        mouse(LEFTUP)
        time.sleep(gap)
    time.sleep(0.6)
elif command == "drag":
    x, y, dx, dy = numbers
    assert u.SetCursorPos(x, y)
    time.sleep(0.15)
    result["cursor"] = cursor()
    mouse(LEFTDOWN)
    time.sleep(0.25)
    steps = 12
    for i in range(1, steps + 1):
        u.SetCursorPos(x + dx * i // steps, y + dy * i // steps)
        time.sleep(0.03)
    time.sleep(0.2)
    mouse(LEFTUP)
    time.sleep(0.5)
    result["cursorAfter"] = cursor()
elif command == "tray-open":
    trays = windows(class_name="tray_icon_app")
    assert len(trays) == 1, trays
    tray = trays[0]
    assert not windows(class_name="#32768"), "A preexisting popup would make selection ambiguous"
    assert u.PostMessageW(tray["hwnd"], 6002, 0, 0x205), "Cannot open actual tray menu"
    end = time.monotonic() + 5
    popups = []
    while time.monotonic() < end:
        popups = windows(class_name="#32768")
        if popups:
            break
        time.sleep(.05)
    assert len(popups) == 1, popups
    menu_handle = ctypes.c_size_t()
    assert u.SendMessageTimeoutW(popups[0]["hwnd"], 0x1e1, 0, 0, 2, 2000, ctypes.byref(menu_handle)), "Cannot inspect actual popup menu"
    items = []
    for index in range(u.GetMenuItemCount(menu_handle.value)):
        label = ctypes.create_unicode_buffer(512)
        u.GetMenuStringW(menu_handle.value, index, label, len(label), 0x400)
        items.append({"index": index, "id": u.GetMenuItemID(menu_handle.value, index), "text": label.value, "state": u.GetMenuState(menu_handle.value, index, 0x400)})
    open_item = items[0]
    assert open_item["text"] == "打开 Kinshoko" and not open_item["state"] & 3 and 0 < open_item["id"] < 0xffff, items
    ignored = ctypes.c_size_t()
    assert u.SendMessageTimeoutW(tray["hwnd"], 0x1f, 0, 0, 2, 2000, ctypes.byref(ignored)), "Cannot close observed menu modal loop"
    end = time.monotonic() + 2
    while windows(class_name="#32768") and time.monotonic() < end:
        time.sleep(.05)
    assert not windows(class_name="#32768"), "Observed native menu did not close"
    assert u.PostMessageW(tray["hwnd"], 0x111, open_item["id"], 0), "Cannot select actual native menu command"
    result["items"] = items
    end = time.monotonic() + 15
    while time.monotonic() < end:
        reopened = windows(title="Kinshoko")
        if reopened and u.IsWindowVisible(w.HWND(reopened[0]["hwnd"])):
            break
        time.sleep(0.1)
    main = windows(title="Kinshoko")
    assert len(main) == 1, main
    hwnd = w.HWND(main[0]["hwnd"])
else:
    raise SystemExit("Unknown command: " + command)
result["after"] = state()
print(json.dumps(result, ensure_ascii=False))
