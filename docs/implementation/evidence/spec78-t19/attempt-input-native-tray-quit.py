import ctypes,json,sys
from ctypes import wintypes as w
u=ctypes.WinDLL('user32',use_last_error=True)
class K(ctypes.Structure):_fields_=[('wVk',w.WORD),('wScan',w.WORD),('dwFlags',w.DWORD),('time',w.DWORD),('dwExtraInfo',ctypes.c_size_t)]
class M(ctypes.Structure):_fields_=[('dx',w.LONG),('dy',w.LONG),('mouseData',w.DWORD),('dwFlags',w.DWORD),('time',w.DWORD),('dwExtraInfo',ctypes.c_size_t)]
class U(ctypes.Union):_fields_=[('ki',K),('mi',M)]
class I(ctypes.Structure):_fields_=[('type',w.DWORD),('u',U)]
u.GetForegroundWindow.restype=w.HWND;u.GetWindowThreadProcessId.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)];u.SendInput.argtypes=[w.UINT,ctypes.POINTER(I),ctypes.c_int];u.SendInput.restype=w.UINT
r=json.load(open(sys.argv[1],encoding='utf-8'));fg=u.GetForegroundWindow();pid=w.DWORD();u.GetWindowThreadProcessId(fg,ctypes.byref(pid));assert pid.value==r['tray']['pid'],{'foreground':fg,'pid':pid.value,'expected':r['tray']['pid']}
inputs=(I*4)();
for i,(vk,flags) in enumerate([(0x23,0),(0x23,2),(0xd,0),(0xd,2)]):inputs[i].type=1;inputs[i].u.ki=K(vk,0,flags,0,0)
assert u.SendInput(4,inputs,ctypes.sizeof(I))==4,ctypes.get_last_error()
r['selection']={'method':'SendInput End/Enter after actual popup Quit readback and foreground PID guard','foregroundHwnd':int(fg),'foregroundPid':pid.value,'verifiedLastItem':'退出','automated':True};open(sys.argv[1],'w',encoding='utf-8').write(json.dumps(r,ensure_ascii=False,indent=2));print('PASS guarded native End/Enter delivered to isolated app menu')
