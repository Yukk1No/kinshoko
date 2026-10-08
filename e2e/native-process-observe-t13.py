"""Read windows or wait for the exact frozen T13 process. No process mutation."""
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

mode, argument = sys.argv[1:3]
application = Path(argument).resolve()
workspace = Path(__file__).resolve().parents[1]
manifest = json.loads((workspace / "work/t13/native-source.json").read_text(encoding="utf-8"))
assert os.path.normcase(str(application)) == os.path.normcase(str(Path(manifest["preservedBinary"]).resolve()))
assert hashlib.sha256(application.read_bytes()).hexdigest() == manifest["binarySha256"].lower()
listed = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T13_EXECUTABLE } | Select-Object -ExpandProperty ProcessId)"], env={**os.environ,"KINSHOKO_T13_EXECUTABLE":str(application)}, creationflags=0x08000000).decode()
pids = json.loads(listed)
assert len(pids) == 1, f"One exact isolated process required: {pids}"
pid = pids[0]
u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
k.CloseHandle.argtypes = [w.HANDLE]
handle = k.OpenProcess(0x100000 | 0x1000, False, pid)
assert handle
try:
    path = ctypes.create_unicode_buffer(32768)
    size = w.DWORD(32768)
    assert k.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size))
    assert os.path.normcase(path.value) == os.path.normcase(str(application))
    if mode == "wait":
        receipt = Path(sys.argv[3]).resolve()
        assert receipt.is_relative_to(workspace / "work/e2e")
        print("ready", flush=True)
        assert k.WaitForSingleObject(handle, 60000) == 0, "No process exit within 60 seconds"
        code = w.DWORD()
        assert k.GetExitCodeProcess(handle, ctypes.byref(code))
        receipt.write_text(json.dumps({"application":path.value,"pid":pid,"exitCode":code.value},indent=2),encoding="utf-8")
    elif mode in ("windows", "hotkey"):
        callback_type = ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
        u.EnumWindows.argtypes = [callback_type,w.LPARAM]
        u.GetWindowThreadProcessId.argtypes = [w.HWND,ctypes.POINTER(w.DWORD)]
        u.GetWindowTextW.argtypes = [w.HWND,w.LPWSTR,ctypes.c_int]
        u.IsWindowVisible.argtypes = [w.HWND]
        found = []
        def visit(hwnd,_):
            owner = w.DWORD()
            u.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
            if owner.value == pid and u.IsWindowVisible(hwnd):
                title=ctypes.create_unicode_buffer(1024)
                u.GetWindowTextW(hwnd,title,len(title))
                found.append({"pid":pid,"hwnd":int(hwnd),"title":title.value})
            return True
        callback=callback_type(visit)
        assert u.EnumWindows(callback,0)
        if mode == "windows":
            print(json.dumps(found))
        else:
            key = sys.argv[3]
            assert key in ("F9", "F10"), key
            main = [item for item in found if item["title"] == "Kinshoko"]
            assert len(main) == 1, main
            u.SetForegroundWindow.argtypes = [w.HWND]
            u.GetForegroundWindow.restype = w.HWND
            u.GetAsyncKeyState.argtypes = [ctypes.c_int]
            u.GetAsyncKeyState.restype = ctypes.c_short
            u.SetForegroundWindow(main[0]["hwnd"])
            time.sleep(.15)
            foreground = u.GetForegroundWindow()
            foreground_pid = w.DWORD()
            u.GetWindowThreadProcessId(foreground,ctypes.byref(foreground_pid))
            assert foreground_pid.value == pid, "Refusing to send input to another program"
            virtual = 0x78 if key == "F9" else 0x79
            assert not any(u.GetAsyncKeyState(vk) & 0x8000 for vk in (0x11,0x12,virtual)), "User is holding a required key"
            class MouseInput(ctypes.Structure):
                _fields_=[("dx",w.LONG),("dy",w.LONG),("mouseData",w.DWORD),("dwFlags",w.DWORD),("time",w.DWORD),("dwExtraInfo",ctypes.c_size_t)]
            class KeyboardInput(ctypes.Structure):
                _fields_=[("wVk",w.WORD),("wScan",w.WORD),("dwFlags",w.DWORD),("time",w.DWORD),("dwExtraInfo",ctypes.c_size_t)]
            class InputUnion(ctypes.Union):
                _fields_=[("mi",MouseInput),("ki",KeyboardInput)]
            class Input(ctypes.Structure):
                _anonymous_=("event",)
                _fields_=[("type",w.DWORD),("event",InputUnion)]
            events=[(0x11,0),(0x12,0),(virtual,0),(virtual,2),(0x12,2),(0x11,2)]
            inputs=(Input*len(events))(*(Input(type=1,event=InputUnion(ki=KeyboardInput(wVk=vk,dwFlags=flags))) for vk,flags in events))
            u.SendInput.argtypes=[w.UINT,ctypes.POINTER(Input),ctypes.c_int]
            sent=u.SendInput(len(inputs),inputs,ctypes.sizeof(Input))
            assert sent == len(inputs), f"SendInput failed: {ctypes.get_last_error()}"
            print(json.dumps({"method":"SendInput","application":path.value,"pid":pid,"foregroundHwnd":int(foreground),"foregroundPid":foreground_pid.value,"key":"Ctrl+Alt+"+key,"events":events,"sent":sent}))
    else:
        raise ValueError(mode)
finally:
    k.CloseHandle(handle)
