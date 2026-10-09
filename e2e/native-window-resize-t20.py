"""Resize the owned T20 main window like a user dragging its frame.

Tauri's WebDriver window/rect does not resize the WebView2 host (round r4 of T20
timed out waiting for any viewport change), so the formal baseline uses the OS:
SetWindowPos on the one visible main HWND of the exact frozen T20 process.
Only that HWND's size changes; position, Z-order and activation are untouched.
Args: <application> <sha256> <delta-width-physical> <delta-height-physical>
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
dw, dh = int(sys.argv[3]), int(sys.argv[4])
owned_workspace = Path(__file__).resolve().parents[1]
assert hashlib.sha256(application.read_bytes()).hexdigest() == expected_sha256, "Application bytes differ from the frozen T20 build"
assert application.is_relative_to(owned_workspace / "work" / "e2e") and "spec78-t20" in str(application) and application.parent.name == "frozen-runtime", application
ctypes.WinDLL("user32").SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
u = ctypes.WinDLL("user32", use_last_error=True)
CALLBACK = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
u.EnumWindows.argtypes = [CALLBACK, w.LPARAM]
u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
u.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.IsWindowVisible.argtypes = [w.HWND]
u.IsIconic.argtypes = [w.HWND]
u.IsZoomed.argtypes = [w.HWND]
u.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
u.SetWindowPos.argtypes = [w.HWND, w.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.UINT]

listed = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T20_EXECUTABLE } | Select-Object -ExpandProperty ProcessId)"], env={**os.environ, "KINSHOKO_T20_EXECUTABLE": str(application)}, creationflags=0x08000000).decode()
pids = json.loads(listed)
assert len(pids) == 1, f"Exactly one owned T20 app required: {pids}"
pid = pids[0]
found = []
def visit(hwnd, _):
    owner = w.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    if owner.value == pid and u.IsWindowVisible(hwnd) and not u.IsIconic(hwnd):
        title = ctypes.create_unicode_buffer(1024)
        u.GetWindowTextW(hwnd, title, len(title))
        found.append({"hwnd": int(hwnd), "title": title.value})
    return True
callback = CALLBACK(visit)
assert u.EnumWindows(callback, 0)
main = [item for item in found if item["title"] == "Kinshoko"]
assert len(main) == 1, found
hwnd = w.HWND(main[0]["hwnd"])
assert not u.IsZoomed(hwnd), "A maximized main window cannot be resized by frame"
def rect():
    r = w.RECT()
    assert u.GetWindowRect(hwnd, ctypes.byref(r))
    return {"x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top}
before = rect()
SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE = 0x2, 0x4, 0x10
assert u.SetWindowPos(hwnd, None, 0, 0, before["width"] + dw, before["height"] + dh, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE), ctypes.get_last_error()
time.sleep(0.1)
after = rect()
print(json.dumps({"method": "SetWindowPos-owned-main", "pid": pid, "hwnd": main[0]["hwnd"], "before": before, "requested": {"dw": dw, "dh": dh}, "after": after, "visibleOwned": found}))
