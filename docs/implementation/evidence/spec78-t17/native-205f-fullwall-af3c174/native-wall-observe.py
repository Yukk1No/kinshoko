"""T17: observe/focus the manifest-bound app and verify/close its exact owned raw fixture.
Adapted from the independently archived T13 process/foreground observer.
No keyboard or mouse input is sent. Other windows are only observed.
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
assert mode in ("focus", "observe", "close", "focus-fixture", "close-fixture")
fixture_identity = None
fixture_hwnd = None
if mode in ("focus-fixture", "close-fixture"):
    assert extra_pid is not None and all(flag in sys.argv for flag in ("--fixture-hwnd", "--fixture-class", "--fixture-script", "--fixture-spawn-after-ms", "--fixture-spawn-before-ms"))
    fixture_hwnd = int(sys.argv[sys.argv.index("--fixture-hwnd") + 1])
    fixture_class = sys.argv[sys.argv.index("--fixture-class") + 1]
    assert fixture_class.startswith("KinshokoT17RawCreate_" + str(extra_pid) + "_")
    fixture_script = Path(sys.argv[sys.argv.index("--fixture-script") + 1]).resolve()
    assert fixture_script.name == "occluder.ps1" and fixture_script.is_relative_to((Path.cwd() / "work/e2e").resolve())
    fixture_process = json.loads(subprocess.check_output([
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:KINSHOKO_T17_FIXTURE_PID) -ErrorAction Stop | ForEach-Object { @{ProcessId=$_.ProcessId;ExecutablePath=$_.ExecutablePath;CommandLine=$_.CommandLine;createdUnixMs=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()} } | ConvertTo-Json -Compress"
    ], env={**os.environ, "KINSHOKO_T17_FIXTURE_PID": str(extra_pid)}, creationflags=0x08000000))
    assert fixture_process["ProcessId"] == extra_pid
    expected_host = Path(os.environ["WINDIR"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    assert os.path.normcase(str(Path(fixture_process["ExecutablePath"]).resolve())) == os.path.normcase(str(expected_host.resolve()))
    spawn_after = int(sys.argv[sys.argv.index("--fixture-spawn-after-ms") + 1])
    spawn_before = int(sys.argv[sys.argv.index("--fixture-spawn-before-ms") + 1])
    assert spawn_after <= fixture_process["createdUnixMs"] <= spawn_before
    # Only this run's exact child, creation interval, HWND and unique class can be verified/closed.
    command = fixture_process["CommandLine"].replace("/", chr(92)).lower().strip().rstrip(chr(34))
    assert "-file " in command and command.endswith(str(fixture_script).lower())
    fixture_identity = {"pid": extra_pid, "hwnd": fixture_hwnd, "className": fixture_class, "script": str(fixture_script),
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
    u.GetClassNameW.argtypes = [w.HWND,w.LPWSTR,ctypes.c_int]
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
    def point_hit(x, y):
        ctypes.set_last_error(0)
        hit = u.WindowFromPoint(w.POINT(x, y)); hit_error = ctypes.get_last_error()
        ctypes.set_last_error(0)
        root = u.GetAncestor(hit, 2) if hit else None; root_error = ctypes.get_last_error()
        root_pid = w.DWORD()
        if root: u.GetWindowThreadProcessId(root, ctypes.byref(root_pid))
        return {"hwnd": int(hit or 0), "lastError": hit_error, "rootHwnd": int(root or 0),
                "rootLastError": root_error, "rootPid": root_pid.value}
    def native_order_at(x, y):
        return {"point": [x, y], "pointWindow": point_hit(x, y),
                "rawVisibleZOrder": [{**item, "index": i} for i, item in enumerate(found)],
                "mainZIndex": next((i for i, item in enumerate(found) if item["hwnd"] == main[0]["hwnd"]), None)}
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
                    class_name = ctypes.create_unicode_buffer(256)
                    assert u.GetClassNameW(hwnd,class_name,len(class_name))
                    fixture.append({**item,"className":class_name.value,"visible":bool(u.IsWindowVisible(hwnd)),"iconic":bool(u.IsIconic(hwnd))})
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
    fixture_closed = None
    if fixture_identity is not None:
        target = next(item for item in fixture if item["hwnd"] == fixture_hwnd)
        assert target["visible"] and not target["iconic"] and target["className"] == fixture_class
        assert len(sys.argv) > 5 and not sys.argv[4].startswith("--")
        point_x, point_y = int(sys.argv[4]), int(sys.argv[5])
        rect = target["rect"]
        assert rect["x"] <= point_x < rect["x"] + rect["width"] and rect["y"] <= point_y < rect["y"] + rect["height"]
        fixture_identity["actualWindow"] = target
        fixture_identity["nativeObserved"] = native_order_at(point_x, point_y)
        if mode == "close-fixture":
            u.PostMessageW.argtypes = [w.HWND,w.UINT,w.WPARAM,w.LPARAM]
            u.PostMessageW.restype = w.BOOL
            u.IsWindow.argtypes = [w.HWND]
            ctypes.set_last_error(0)
            posted = bool(u.PostMessageW(fixture_hwnd,0x0010,0,0))
            post_error = ctypes.get_last_error()
            assert posted, post_error
            deadline = time.monotonic() + 5
            while u.IsWindow(fixture_hwnd) and time.monotonic() < deadline:
                owner = w.DWORD(); u.GetWindowThreadProcessId(fixture_hwnd,ctypes.byref(owner))
                if owner.value != extra_pid: break
                time.sleep(.05)
            owner = w.DWORD()
            if u.IsWindow(fixture_hwnd): u.GetWindowThreadProcessId(fixture_hwnd,ctypes.byref(owner))
            fixture_closed = {"posted":posted,"lastError":post_error,"hwnd":fixture_hwnd,"stillSamePid":owner.value==extra_pid}
            assert not fixture_closed["stillSamePid"], "Owned raw fixture HWND did not close"
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
        point_window = point_hit(*point)
        r=main[0]["rect"]
        assert r["x"]<=point[0]<r["x"]+r["width"] and r["y"]<=point[1]<r["y"]+r["height"], "Only owned main bounds may be observed"
        above=[item for item in above if item["rect"]["x"]<=point[0]<item["rect"]["x"]+item["rect"]["width"] and item["rect"]["y"]<=point[1]<item["rect"]["y"]+item["rect"]["height"]]
    print(json.dumps({"application":path.value,"pid":pid,"mainHwnd":main[0]["hwnd"],"foregroundHwnd":int(foreground or 0),"foregroundPid":foreground_pid.value,"activated":activated,"destroyed":closed,"beforeMain":before_main,"mainInVisibleZOrder":position is not None,"point":point,"pointWindow":point_window,"rawVisibleZOrder":raw_visible_z_order,"mainZIndex":position,"covering":above,"owned":owned,"testOccluderPid":extra_pid,"testOccluderWindows":fixture,"fixtureIdentity":fixture_identity,"fixtureClosed":fixture_closed,"dpiCoordinates":"per-monitor-v2 physical"}))
finally:
    k.CloseHandle(handle)
