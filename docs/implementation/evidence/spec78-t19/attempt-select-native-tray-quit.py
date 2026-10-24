import ctypes,json,os,sys,time
from ctypes import wintypes as w
u=ctypes.WinDLL('user32',use_last_error=True);k=ctypes.WinDLL('kernel32',use_last_error=True)
u.GetWindowThreadProcessId.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)];u.GetClassNameW.argtypes=[w.HWND,w.LPWSTR,ctypes.c_int];u.PostMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];u.SendMessageTimeoutW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM,w.UINT,w.UINT,ctypes.POINTER(ctypes.c_size_t)]
u.GetMenuItemCount.argtypes=[w.HMENU];u.GetMenuStringW.argtypes=[w.HMENU,w.UINT,w.LPWSTR,ctypes.c_int,w.UINT]
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE;k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)];k.CloseHandle.argtypes=[w.HANDLE]
r=json.load(open(sys.argv[1],encoding='utf-8-sig'));p=r['popup'];pid=w.DWORD();u.GetWindowThreadProcessId(p['hwnd'],ctypes.byref(pid));assert pid.value==p['pid'];b=ctypes.create_unicode_buffer(128);u.GetClassNameW(p['hwnd'],b,128);assert b.value=='#32768'
h=k.OpenProcess(0x1000,False,pid.value);path=ctypes.create_unicode_buffer(32768);n=w.DWORD(32768);assert k.QueryFullProcessImageNameW(h,0,path,ctypes.byref(n));k.CloseHandle(h);assert os.path.normcase(path.value)==os.path.normcase(p['path'])
out=ctypes.c_size_t();assert u.SendMessageTimeoutW(p['hwnd'],0x1e1,0,0,2,2000,ctypes.byref(out));assert out.value==r['menu'];count=u.GetMenuItemCount(out.value);b=ctypes.create_unicode_buffer(512);u.GetMenuStringW(out.value,count-1,b,512,0x400);assert b.value=='退出',repr(b.value)
assert u.PostMessageW(p['hwnd'],0x100,0x23,0);time.sleep(.1);assert u.PostMessageW(p['hwnd'],0x100,0x0d,0)
r['selection']={'method':'WM_KEYDOWN VK_END then VK_RETURN to verified actual popup window','verifiedLastItem':b.value,'automated':True};open(sys.argv[2],'w',encoding='utf-8').write(json.dumps(r,ensure_ascii=False,indent=2));print('PASS actual native tray menu selected its verified Quit item')
