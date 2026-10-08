import ctypes, json, os, sys, time
from ctypes import wintypes as w
u=ctypes.WinDLL('user32',use_last_error=True); k=ctypes.WinDLL('kernel32',use_last_error=True)
u.GetWindowThreadProcessId.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)];u.GetClassNameW.argtypes=[w.HWND,w.LPWSTR,ctypes.c_int]
u.PostMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];u.SendMessageTimeoutW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM,w.UINT,w.UINT,ctypes.POINTER(ctypes.c_size_t)]
u.GetMenuItemCount.argtypes=[w.HMENU];u.GetMenuStringW.argtypes=[w.HMENU,w.UINT,w.LPWSTR,ctypes.c_int,w.UINT];u.GetMenuItemID.argtypes=[w.HMENU,ctypes.c_int]
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE;k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)];k.CloseHandle.argtypes=[w.HANDLE]
CB=ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM);u.EnumWindows.argtypes=[CB,w.LPARAM]
expected=os.path.normcase(os.path.abspath(sys.argv[1]));rows=[]
def enum(hwnd,_):
 p=w.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(p));b=ctypes.create_unicode_buffer(512);u.GetClassNameW(hwnd,b,512)
 if b.value in ('tray_icon_app','#32768'):
  h=k.OpenProcess(0x1000,False,p.value);path=ctypes.create_unicode_buffer(32768);n=w.DWORD(32768)
  try:
   if h and k.QueryFullProcessImageNameW(h,0,path,ctypes.byref(n)) and os.path.normcase(path.value)==expected:rows.append({'hwnd':int(hwnd),'pid':p.value,'class':b.value,'path':path.value})
  finally:
   if h:k.CloseHandle(h)
 return True
u.EnumWindows(CB(enum),0);trays=[r for r in rows if r['class']=='tray_icon_app'];assert len(trays)==1,rows
tray=trays[0];assert u.PostMessageW(tray['hwnd'],6002,0,0x205),ctypes.get_last_error();time.sleep(.4);rows=[];u.EnumWindows(CB(enum),0)
popups=[r for r in rows if r['class']=='#32768'];assert len(popups)==1,rows
popup=popups[0];out=ctypes.c_size_t();assert u.SendMessageTimeoutW(popup['hwnd'],0x1e1,0,0,2,2000,ctypes.byref(out)),ctypes.get_last_error();menu=out.value;count=u.GetMenuItemCount(menu);items=[]
for i in range(count):
 b=ctypes.create_unicode_buffer(512);u.GetMenuStringW(menu,i,b,512,0x400);items.append({'index':i,'id':u.GetMenuItemID(menu,i),'text':b.value})
receipt={'tray':tray,'popup':popup,'menu':menu,'items':items,'method':'PostMessage WM_USER_TRAYICON=6002, WM_RBUTTONUP=0x205; actual native menu opened'}
print(json.dumps(receipt,ensure_ascii=False),flush=True)
if len(sys.argv)>2:open(sys.argv[2],'w',encoding='utf-8').write(json.dumps(receipt,ensure_ascii=False,indent=2))
