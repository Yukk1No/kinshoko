"""Select Quit on the real tray menu of the isolated T05 verification product.

Only its actual PID/path, freshly opened popup, menu owner and read-back Quit ID
are accepted. WM_COMMAND enters muda's regular menu callback and normal app exit.
No private IPC, WM_QUIT, process termination or global keyboard input is used.
"""
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
import sys
import time

application = Path(sys.argv[1]).resolve()
receipt_path = Path(sys.argv[2]).resolve()
owned_workspace = Path(__file__).resolve().parents[1]
expected_application = owned_workspace / "target" / "debug" / "kinshoko.exe"
assert os.path.normcase(str(application)) == os.path.normcase(str(expected_application)), application
assert receipt_path.is_relative_to(owned_workspace / "work" / "e2e"), receipt_path
u = ctypes.WinDLL("user32", use_last_error=True)
k = ctypes.WinDLL("kernel32", use_last_error=True)
CALLBACK = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
u.EnumWindows.argtypes = [CALLBACK, w.LPARAM]
u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
u.GetWindowThreadProcessId.restype = w.DWORD
u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
u.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
u.SendMessageTimeoutW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM, w.UINT, w.UINT, ctypes.POINTER(ctypes.c_size_t)]
u.GetMenuItemCount.argtypes = [w.HMENU]
u.GetMenuStringW.argtypes = [w.HMENU, w.UINT, w.LPWSTR, ctypes.c_int, w.UINT]
u.GetMenuItemID.argtypes = [w.HMENU, ctypes.c_int]
u.GetMenuItemID.restype = w.UINT
u.GetMenuState.argtypes = [w.HMENU, w.UINT, w.UINT]
u.GetMenuState.restype = w.UINT
class GUIThreadInfo(ctypes.Structure):
    _fields_ = [("cbSize", w.DWORD), ("flags", w.DWORD), ("hwndActive", w.HWND), ("hwndFocus", w.HWND), ("hwndCapture", w.HWND), ("hwndMenuOwner", w.HWND), ("hwndMoveSize", w.HWND), ("hwndCaret", w.HWND), ("rcCaret", w.RECT)]
u.GetGUIThreadInfo.argtypes = [w.DWORD, ctypes.POINTER(GUIThreadInfo)]
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
k.CloseHandle.argtypes = [w.HANDLE]

listed = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:KINSHOKO_T04_EXECUTABLE } | Select-Object -ExpandProperty ProcessId)"], env={**os.environ, "KINSHOKO_T04_EXECUTABLE": str(application)}, creationflags=0x08000000).decode()
pids = json.loads(listed)
assert len(pids) == 1, f"Exactly one isolated test app required: {pids}"
pid = pids[0]
handle = k.OpenProcess(0x100000 | 0x1000, False, pid)
assert handle, "Cannot inspect isolated app"
try:
    path = ctypes.create_unicode_buffer(32768)
    size = w.DWORD(32768)
    assert k.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size))
    assert os.path.normcase(path.value) == os.path.normcase(str(application)), path.value
    def windows(window_class):
        found = []
        def visit(hwnd, _):
            owner_pid = w.DWORD()
            thread = u.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
            name = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, name, len(name))
            if owner_pid.value == pid and name.value == window_class:
                found.append({"hwnd": int(hwnd), "pid": owner_pid.value, "thread": thread, "class": name.value})
            return True
        callback = CALLBACK(visit)
        assert u.EnumWindows(callback, 0)
        return found
    trays = windows("tray_icon_app")
    assert len(trays) == 1, trays
    tray = trays[0]
    assert not windows("#32768"), "A preexisting popup would make selection ambiguous"
    assert u.PostMessageW(tray["hwnd"], 6002, 0, 0x205), "Cannot open actual tray menu"
    end = time.monotonic() + 5
    popups = []
    while time.monotonic() < end:
        popups = windows("#32768")
        if popups:
            break
        time.sleep(.05)
    assert len(popups) == 1, popups
    popup = popups[0]
    info = GUIThreadInfo(cbSize=ctypes.sizeof(GUIThreadInfo))
    assert u.GetGUIThreadInfo(popup["thread"], ctypes.byref(info))
    assert int(info.hwndMenuOwner or 0) == tray["hwnd"], f"Unexpected popup owner: {info.hwndMenuOwner}"
    result = ctypes.c_size_t()
    assert u.SendMessageTimeoutW(popup["hwnd"], 0x1e1, 0, 0, 2, 2000, ctypes.byref(result)), "Cannot inspect actual popup menu"
    menu = result.value
    count = u.GetMenuItemCount(menu)
    assert count > 0
    items = []
    for index in range(count):
        label = ctypes.create_unicode_buffer(512)
        u.GetMenuStringW(menu, index, label, len(label), 0x400)
        items.append({"index": index, "id": u.GetMenuItemID(menu, index), "text": label.value, "state": u.GetMenuState(menu, index, 0x400)})
    quit_item = items[-1]
    assert quit_item["text"] == "退出" and not quit_item["state"] & 3, quit_item
    assert 0 < quit_item["id"] < 0xffff, quit_item
    receipt = {"method": "automated-native-menu-dispatch", "application": path.value, "pid": pid, "tray": tray, "popup": popup, "popupOwner": int(info.hwndMenuOwner), "menu": menu, "items": items, "openMessage": {"message": 6002, "lParam": 0x205}, "selectionMessage": {"message": 0x111, "wParam": quit_item["id"], "lParam": 0}}
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    # TrackPopupMenu must return before Tauri consumes the menu event. A real
    # selection closes this modal menu, then dispatches its WM_COMMAND.
    ignored = ctypes.c_size_t()
    assert u.SendMessageTimeoutW(tray["hwnd"], 0x1f, 0, 0, 2, 2000, ctypes.byref(ignored)), "Cannot close observed menu modal loop"
    end = time.monotonic() + 2
    while windows("#32768") and time.monotonic() < end:
        time.sleep(.05)
    assert not windows("#32768"), "Observed native menu did not close"
    receipt["menuClosedBeforeDispatch"] = True
    receipt["closeMenuMessage"] = 0x1f
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    assert u.PostMessageW(tray["hwnd"], 0x111, quit_item["id"], 0), "Cannot select actual native menu command"
    assert k.WaitForSingleObject(handle, 30000) == 0, "App did not exit normally within 30 seconds"
    code = w.DWORD()
    assert k.GetExitCodeProcess(handle, ctypes.byref(code))
    receipt["exitCode"] = code.value
    receipt["processEnded"] = True
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    assert code.value == 0, f"Nonzero exit code: {code.value}"
    print("PASS automated-native-menu-dispatch: verified Quit item, normal exit code 0")
finally:
    k.CloseHandle(handle)
