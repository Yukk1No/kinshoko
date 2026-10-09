"""T17: observe/focus the manifest-bound app; explicitly place its owned test fixture once.
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
extra_pid = int(sys.argv[sys.argv.index("--owned-occluder") + 1]) if "--owned-occluder" in sys.argv else None
assert mode in ("focus", "observe", "close", "focus-fixture")
fixture_placement = None
fixture_hwnd = None
if mode == "focus-fixture":
    assert extra_pid is not None and all(flag in sys.argv for flag in ("--fixture-hwnd", "--fixture-script", "--fixture-spawn-after-ms", "--fixture-spawn-before-ms"))
    fixture_hwnd = int(sys.argv[sys.argv.index("--fixture-hwnd") + 1])
    fixture_script = Path(sys.argv[sys.argv.index("--fixture-script") + 1]).resolve()
    assert fixture_script.name == "occluder.ps1" and fixture_script.is_relative_to((Path.cwd() / "work/e2e").resolve())
    fixture_process = json.loads(subprocess.check_output([
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:KINSHOKO_T17_FIXTURE_PID) | ForEach-Object { @{ProcessId=$_.ProcessId;ExecutablePath=$_.ExecutablePath;CommandLine=$_.CommandLine;createdUnixMs=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()} } | ConvertTo-Json -Compress"
    ], env={**os.environ, "KINSHOKO_T17_FIXTURE_PID": str(extra_pid)}, creationflags=0x08000000))
    assert fixture_process["ProcessId"] == extra_pid
    assert Path(fixture_process["ExecutablePath"]).name.lower() == "powershell.exe"
    spawn_after = int(sys.argv[sys.argv.index("--fixture-spawn-after-ms") + 1])
    spawn_before = int(sys.argv[sys.argv.index("--fixture-spawn-before-ms") + 1])
    assert spawn_after <= fixture_process["createdUnixMs"] <= spawn_before
    # Only the exact child launched with this run's generated -File can be repositioned.
    command = fixture_process["CommandLine"].replace("/", chr(92)).lower().strip().rstrip(chr(34))
    assert "-file " in command and command.endswith(str(fixture_script).lower())
    fixture_placement = {"pid": extra_pid, "hwnd": fixture_hwnd, "script": str(fixture_script),
                         "scriptSha256": hashlib.sha256(fixture_script.read_bytes()).hexdigest(),
                         "actualProcess": fixture_process, "spawnIntervalUnixMs": [spawn_after, spawn_before]}
assert os.path.normcase(str(application)) == os.path.normcase(str(Path(manifest["application"]).resolve()))
assert hashlib.sha256(application.read_bytes()).hexdigest() == manifest["binarySha256"].lower()
listed = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T17_EXECUTABLE } | Select-Object -ExpandProperty ProcessId)"], env={**os.environ,"KINSHOKO_T17_EXECUTABLE":str(application)}, creationflags=0x08000000)
pids = json.loads(listed)
assert len(pids) == 1, pids
pid = pids[0]
u = ctypes.WinDLL("user32", use_last_error=True)
u.SetThreadDpiAwarenessContext.argtypes = [w.HANDLE]
u.SetThreadDpiAwarenessContext.restype = w.HANDLE
previous_dpi_context = u.SetThreadDpiAwarenessContext(w.HANDLE(-4))
assert previous_dpi_context, "The test observer must report physical per-monitor coordinates"
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
    u.GetWindowLongPtrW.argtypes = [w.HWND,ctypes.c_int]
    u.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    u.WindowFromPoint.argtypes = [w.POINT]
    u.WindowFromPoint.restype = w.HWND
    u.GetAncestor.argtypes = [w.HWND,w.UINT]
    u.GetAncestor.restype = w.HWND
    found = []
    owned = []
    fixture = []
    def extended_style(hwnd):
        ctypes.set_last_error(0)
        value = int(u.GetWindowLongPtrW(hwnd,-20))
        error = ctypes.get_last_error()
        return {"value":value,"lastError":error,"topmost":bool(value & 8)}
    def visit(hwnd,_):
        owner = w.DWORD()
        u.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
        if owner.value in (pid, extra_pid) or (u.IsWindowVisible(hwnd) and not u.IsIconic(hwnd)):
            rect = w.RECT()
            if u.GetWindowRect(hwnd,ctypes.byref(rect)):
                item = {"pid":owner.value,"hwnd":int(hwnd),"rect":{"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top},"extendedStyle":extended_style(hwnd)}
                if u.IsWindowVisible(hwnd) and not u.IsIconic(hwnd):
                    found.append(item)
                if owner.value == extra_pid:
                    fixture.append({**item,"visible":bool(u.IsWindowVisible(hwnd)),"iconic":bool(u.IsIconic(hwnd))})
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
    if mode in ("focus", "focus-fixture"):
        u.ShowWindow.argtypes = [w.HWND,ctypes.c_int]
        u.ShowWindow(main[0]["hwnd"],9)
        activated=bool(u.SetForegroundWindow(main[0]["hwnd"]))
        time.sleep(.15)
        found.clear(); owned.clear(); fixture.clear()
        assert u.EnumWindows(callback,0)
    if fixture_placement is not None:
        target = next(item for item in fixture if item["hwnd"] == fixture_hwnd)
        assert target["visible"] and not target["iconic"]
        assert len(sys.argv) > 5 and not sys.argv[4].startswith("--")
        point_x, point_y = int(sys.argv[4]), int(sys.argv[5])
        rect = target["rect"]
        assert rect["x"] <= point_x < rect["x"] + rect["width"] and rect["y"] <= point_y < rect["y"] + rect["height"]
        fixture_placement["beforeWindow"] = target
        u.SetWindowPos.argtypes = [w.HWND, w.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.UINT]
        u.SetWindowPos.restype = w.BOOL
        ctypes.set_last_error(0)
        placed = bool(u.SetWindowPos(fixture_hwnd, w.HWND(-1), rect["x"], rect["y"], rect["width"], rect["height"], 0x50))
        fixture_placement["setWindowPos"] = {"returned": placed, "lastError": ctypes.get_last_error(), "flags": 0x50, "insertAfter": -1}
        fixture_placement["immediateStyle"] = extended_style(fixture_hwnd)
        time.sleep(.15)
        found.clear(); owned.clear(); fixture.clear()
        assert u.EnumWindows(callback,0)
    closed = None
    if mode == "close":
        # WM_CLOSE is the native title-bar close action, restricted to the checked owned main HWND.
        u.PostMessageW.argtypes = [w.HWND,w.UINT,w.WPARAM,w.LPARAM]
        u.IsWindow.argtypes = [w.HWND]
        assert u.PostMessageW(main[0]["hwnd"],0x0010,0,0)
        deadline=time.monotonic()+5
        while u.IsWindow(main[0]["hwnd"]) and time.monotonic()<deadline:
            time.sleep(.05)
        closed = not bool(u.IsWindow(main[0]["hwnd"]))
        assert closed, "The owned main HWND did not actually close"
    foreground=u.GetForegroundWindow()
    foreground_pid=w.DWORD()
    u.GetWindowThreadProcessId(foreground,ctypes.byref(foreground_pid))
    position=next((i for i,item in enumerate(found) if item["hwnd"]==main[0]["hwnd"]),None)
    above=found[:position] if position is not None else found
    raw_visible_z_order = [{**item,"index":i} for i,item in enumerate(found)]
    point=None
    point_window=None
    if len(sys.argv)>5 and not sys.argv[4].startswith("--"):
        point=[int(sys.argv[4]),int(sys.argv[5])]
        ctypes.set_last_error(0)
        hit=u.WindowFromPoint(w.POINT(*point)); hit_error=ctypes.get_last_error()
        ctypes.set_last_error(0)
        root=u.GetAncestor(hit,2) if hit else None; root_error=ctypes.get_last_error()
        root_pid=w.DWORD()
        if root: u.GetWindowThreadProcessId(root,ctypes.byref(root_pid))
        point_window={"hwnd":int(hit or 0),"lastError":hit_error,"rootHwnd":int(root or 0),"rootLastError":root_error,"rootPid":root_pid.value}
        r=main[0]["rect"]
        assert r["x"]<=point[0]<r["x"]+r["width"] and r["y"]<=point[1]<r["y"]+r["height"], "Only owned main bounds may be observed"
        above=[item for item in above if item["rect"]["x"]<=point[0]<item["rect"]["x"]+item["rect"]["width"] and item["rect"]["y"]<=point[1]<item["rect"]["y"]+item["rect"]["height"]]
    print(json.dumps({"application":path.value,"pid":pid,"mainHwnd":main[0]["hwnd"],"foregroundHwnd":int(foreground or 0),"foregroundPid":foreground_pid.value,"activated":activated,"destroyed":closed,"beforeMain":before_main,"mainInVisibleZOrder":position is not None,"point":point,"pointWindow":point_window,"rawVisibleZOrder":raw_visible_z_order,"mainZIndex":position,"covering":above,"owned":owned,"testOccluderPid":extra_pid,"testOccluderWindows":fixture,"fixturePlacement":fixture_placement,"dpiCoordinates":"per-monitor-v2 physical"}))
finally:
    k.CloseHandle(handle)
