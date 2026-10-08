"""T17: observe/focus only the manifest-bound owned native process.
Adapted from the independently archived T13 process/foreground observer.
No keyboard or mouse input is sent. Other windows contribute only HWND/PID/bounds.
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
manifest = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8-sig"))
mode = sys.argv[3]
assert mode in ("focus", "observe")
assert os.path.normcase(str(application)) == os.path.normcase(str(Path(manifest["application"]).resolve()))
assert hashlib.sha256(application.read_bytes()).hexdigest() == manifest["binarySha256"].lower()
listed = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T17_EXECUTABLE } | Select-Object -ExpandProperty ProcessId)"], env={**os.environ,"KINSHOKO_T17_EXECUTABLE":str(application)}, creationflags=0x08000000)
pids = json.loads(listed)
assert len(pids) == 1, pids
pid = pids[0]
u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
k.CloseHandle.argtypes = [w.HANDLE]
handle = k.OpenProcess(0x1000, False, pid)
assert handle
try:
    path = ctypes.create_unicode_buffer(32768)
    size = w.DWORD(32768)
    assert k.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size))
    assert os.path.normcase(path.value) == os.path.normcase(str(application))
    callback_type = ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
    u.EnumWindows.argtypes = [callback_type,w.LPARAM]
    u.GetWindowThreadProcessId.argtypes = [w.HWND,ctypes.POINTER(w.DWORD)]
    u.GetWindowTextW.argtypes = [w.HWND,w.LPWSTR,ctypes.c_int]
    u.IsWindowVisible.argtypes = [w.HWND]
    u.IsIconic.argtypes = [w.HWND]
    u.GetWindowRect.argtypes = [w.HWND,ctypes.POINTER(w.RECT)]
    found = []
    owned = []
    def visit(hwnd,_):
        owner = w.DWORD()
        u.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
        if owner.value == pid or (u.IsWindowVisible(hwnd) and not u.IsIconic(hwnd)):
            rect = w.RECT()
            if u.GetWindowRect(hwnd,ctypes.byref(rect)):
                item = {"pid":owner.value,"hwnd":int(hwnd),"rect":{"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top}}
                if u.IsWindowVisible(hwnd) and not u.IsIconic(hwnd):
                    found.append(item)
                if owner.value == pid:
                    title=ctypes.create_unicode_buffer(1024)
                    u.GetWindowTextW(hwnd,title,len(title))
                    owned.append({**item,"title":title.value,"visible":bool(u.IsWindowVisible(hwnd)),"iconic":bool(u.IsIconic(hwnd))})
        return True
    callback=callback_type(visit)
    assert u.EnumWindows(callback,0)
    main=[item for item in owned if item["title"]=="Kinshoko"]
    assert len(main)==1, owned
    u.SetForegroundWindow.argtypes = [w.HWND]
    u.GetForegroundWindow.restype = w.HWND
    activated = None
    before_main = main[0].copy()
    if mode=="focus":
        u.ShowWindow.argtypes = [w.HWND,ctypes.c_int]
        u.ShowWindow(main[0]["hwnd"],9)
        activated=bool(u.SetForegroundWindow(main[0]["hwnd"]))
        time.sleep(.15)
        found.clear(); owned.clear()
        assert u.EnumWindows(callback,0)
    foreground=u.GetForegroundWindow()
    foreground_pid=w.DWORD()
    u.GetWindowThreadProcessId(foreground,ctypes.byref(foreground_pid))
    position=next((i for i,item in enumerate(found) if item["hwnd"]==main[0]["hwnd"]),None)
    above=found[:position] if position is not None else found
    point=None
    if len(sys.argv)>5:
        point=[int(sys.argv[4]),int(sys.argv[5])]
        r=main[0]["rect"]
        assert r["x"]<=point[0]<r["x"]+r["width"] and r["y"]<=point[1]<r["y"]+r["height"], "Only owned main bounds may be observed"
        above=[item for item in above if item["rect"]["x"]<=point[0]<item["rect"]["x"]+item["rect"]["width"] and item["rect"]["y"]<=point[1]<item["rect"]["y"]+item["rect"]["height"]]
    print(json.dumps({"application":path.value,"pid":pid,"mainHwnd":main[0]["hwnd"],"foregroundHwnd":int(foreground or 0),"foregroundPid":foreground_pid.value,"activated":activated,"beforeMain":before_main,"mainInVisibleZOrder":position is not None,"point":point,"covering":above,"owned":owned}))
finally:
    k.CloseHandle(handle)
