import ctypes,json,time,sys
from pathlib import Path
from ctypes import wintypes as w
u=ctypes.WinDLL('user32',use_last_error=True)
u.CountClipboardFormats.argtypes=[];u.CountClipboardFormats.restype=ctypes.c_int
u.GetClipboardSequenceNumber.argtypes=[];u.GetClipboardSequenceNumber.restype=w.DWORD
u.GetOpenClipboardWindow.argtypes=[];u.GetOpenClipboardWindow.restype=w.HWND
u.GetClipboardOwner.argtypes=[];u.GetClipboardOwner.restype=w.HWND
u.GetWindowThreadProcessId.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)];u.GetWindowThreadProcessId.restype=w.DWORD
u.RegisterClipboardFormatW.argtypes=[w.LPCWSTR];u.RegisterClipboardFormatW.restype=w.UINT
u.IsClipboardFormatAvailable.argtypes=[w.UINT];u.IsClipboardFormatAvailable.restype=w.BOOL
def api(name,*args):
 ctypes.set_last_error(0)
 value=getattr(u,name)(*args)
 error=ctypes.get_last_error()
 return {'value':int(value or 0),'lastError':error}
png_registration=api('RegisterClipboardFormatW','PNG')
formats=[('CF_BITMAP',2),('CF_DIB',8),('CF_DIBV5',17),('CF_UNICODETEXT',13),('CF_HDROP',15),('PNG',png_registration['value'])]
def window(name):
 value=api(name);h=value['value']
 result={'hwnd':h,'lastError':value['lastError']}
 if h:
  pid=w.DWORD();thread=api('GetWindowThreadProcessId',h,ctypes.byref(pid))
  result.update({'threadId':thread['value'],'pid':int(pid.value),'pidLastError':thread['lastError']})
 return result
def current():
 before=api('GetClipboardSequenceNumber')
 count=api('CountClipboardFormats')
 availability={name:{'format':identifier,**api('IsClipboardFormatAvailable',identifier)} for name,identifier in formats if identifier}
 open_window=window('GetOpenClipboardWindow');owner=window('GetClipboardOwner')
 after=api('GetClipboardSequenceNumber')
 stable=before['value']!=0 and before['value']==after['value'] and before['lastError']==0 and after['lastError']==0
 empty=stable and count['value']==0 and count['lastError']==0 and png_registration['value']!=0 and png_registration['lastError']==0 and all(v['value']==0 and v['lastError']==0 for v in availability.values())
 return {'atUnix':int(time.time()*1000),'monotonicNs':time.perf_counter_ns(),'formats':count['value'],'formatsLastError':count['lastError'],'sequence':after['value'],'sequenceBefore':before,'sequenceAfter':after,'stableSequence':stable,'emptyVerified':empty,'available':availability,'pngRegistration':png_registration,'openWindow':open_window,'owner':owner,'interpretation':'NULL open/owner HWND does not imply closed; no OpenClipboard is attempted by this observer.'}
if len(sys.argv)>1:
 p=Path(sys.argv[1]);initial=current();(p/'clipboard-monitor-ready.json').write_text(json.dumps(initial))
 end=time.monotonic()+90;previous=None
 with (p/'clipboard-metadata-timeline.jsonl').open('w') as out:
  while time.monotonic()<end:
   entry=current();signature=(entry['formats'],entry['formatsLastError'],entry['sequence'],entry['emptyVerified'],entry['openWindow']['hwnd'],entry['owner']['hwnd'])
   if signature!=previous:
    out.write(json.dumps(entry)+'\n');out.flush();previous=signature
   if entry['emptyVerified'] and entry['sequence']!=initial['sequence']:
    (p/'clipboard-observed-empty.json').write_text(json.dumps(entry));break
   time.sleep(.002)
else: print(json.dumps(current()))
