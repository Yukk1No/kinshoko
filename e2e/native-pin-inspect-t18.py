"""Read native visibility of one pin owned by the exact frozen T18 executable.

No ShowWindow, input, window mutation, or production override is used.
"""
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

application = Path(sys.argv[1]).resolve()
workspace = Path(__file__).resolve().parents[1]
manifest = json.loads((workspace / "work/t18/native-source.json").read_text(encoding="utf-8"))
assert os.path.normcase(str(application)) == os.path.normcase(str(Path(manifest["preservedBinary"]).resolve()))
assert hashlib.sha256(application.read_bytes()).hexdigest() == manifest["binarySha256"]
listed = subprocess.check_output([
    "powershell", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T18_EXECUTABLE } | Select-Object -ExpandProperty ProcessId)",
], env={**os.environ, "KINSHOKO_T18_EXECUTABLE": str(application)}, creationflags=0x08000000)
pids = json.loads(listed)
assert len(pids) == 1, f"One exact isolated process required: {pids}"
pid = pids[0]
u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
k.CloseHandle.argtypes = [w.HANDLE]
callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
u.EnumWindows.argtypes = [callback_type, w.LPARAM]
u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
u.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.IsWindowVisible.argtypes = [w.HWND]
u.IsWindowVisible.restype = w.BOOL
handle = k.OpenProcess(0x1000, False, pid)
assert handle
try:
    image = ctypes.create_unicode_buffer(32768)
    size = w.DWORD(len(image))
    assert k.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size))
    assert os.path.normcase(image.value) == os.path.normcase(str(application))
    found = []

    def visit(hwnd, _):
        owner = w.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid:
            title = ctypes.create_unicode_buffer(1024)
            u.GetWindowTextW(hwnd, title, len(title))
            if title.value == "Kinshoko 钉图":
                name = ctypes.create_unicode_buffer(256)
                u.GetClassNameW(hwnd, name, len(name))
                found.append({"pid": pid, "hwnd": int(hwnd), "title": title.value, "class": name.value, "visible": bool(u.IsWindowVisible(hwnd))})
        return True

    callback = callback_type(visit)
    assert u.EnumWindows(callback, 0)
    assert len(found) == 1, f"One observed owned pin required: {found}"
    print(json.dumps(found[0]))
finally:
    k.CloseHandle(handle)
