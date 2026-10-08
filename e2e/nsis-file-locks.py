"""Read RestartManager users of the isolated test executable; never closes them."""
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import sys

application = Path(sys.argv[1]).resolve()
assert application.name == "kinshoko-t19-upgrade.exe" and "t19-upgrade" in application.parts
class UniqueProcess(ctypes.Structure):
    _fields_ = [("pid", w.DWORD), ("start", w.FILETIME)]
class ProcessInfo(ctypes.Structure):
    _fields_ = [("process", UniqueProcess), ("appName", w.WCHAR * 256), ("serviceName", w.WCHAR * 64), ("appType", ctypes.c_int), ("status", w.ULONG), ("session", w.DWORD), ("restartable", w.BOOL)]
r = ctypes.WinDLL("rstrtmgr")
r.RmStartSession.argtypes = [ctypes.POINTER(w.DWORD), w.DWORD, w.LPWSTR]
r.RmRegisterResources.argtypes = [w.DWORD, w.UINT, ctypes.POINTER(w.LPCWSTR), w.UINT, ctypes.POINTER(UniqueProcess), w.UINT, ctypes.POINTER(w.LPCWSTR)]
r.RmGetList.argtypes = [w.DWORD, ctypes.POINTER(w.UINT), ctypes.POINTER(w.UINT), ctypes.POINTER(ProcessInfo), ctypes.POINTER(w.DWORD)]
r.RmEndSession.argtypes = [w.DWORD]
k = ctypes.WinDLL("kernel32")
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
k.CloseHandle.argtypes = [w.HANDLE]
session = w.DWORD()
key = ctypes.create_unicode_buffer(33)
assert r.RmStartSession(ctypes.byref(session), 0, key) == 0
try:
    files = (w.LPCWSTR * 1)(str(application))
    assert r.RmRegisterResources(session.value, 1, files, 0, None, 0, None) == 0
    needed, count, reason = w.UINT(), w.UINT(), w.DWORD()
    status = r.RmGetList(session.value, ctypes.byref(needed), ctypes.byref(count), None, ctypes.byref(reason))
    assert status in (0, 234), status
    users = []
    if needed.value:
        entries = (ProcessInfo * needed.value)()
        count.value = needed.value
        assert r.RmGetList(session.value, ctypes.byref(needed), ctypes.byref(count), entries, ctypes.byref(reason)) == 0
        for item in entries[:count.value]:
            path = ctypes.create_unicode_buffer(32768)
            size = w.DWORD(32768)
            handle = k.OpenProcess(0x1000, False, item.process.pid)
            try:
                known = bool(handle and k.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)))
            finally:
                if handle:
                    k.CloseHandle(handle)
            users.append({"pid": item.process.pid, "appName": item.appName, "executablePath": path.value if known else None, "appType": item.appType, "restartable": bool(item.restartable)})
    print(json.dumps({"application": str(application), "users": users, "rebootReasons": reason.value}, ensure_ascii=False))
finally:
    r.RmEndSession(session.value)
