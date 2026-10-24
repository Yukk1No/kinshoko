// Test-only qualification candidate: one raw window is created with WS_EX_TOPMOST.
// Compile offline before freezing a native lease. Run once in its own 64-bit STA process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class T17RawCreateTopmost {
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate IntPtr WindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
  [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr Hwnd;public uint Id;public IntPtr WParam,LParam;public uint Time;public Point Position;public uint Private;}
  [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
  [StructLayout(LayoutKind.Sequential)] struct WindowPos {public IntPtr Hwnd,InsertAfter;public int X,Y,Cx,Cy;public uint Flags;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {public uint Size,Style;public IntPtr Proc;public int ClassExtra,WindowExtra;public IntPtr Instance,Icon,Cursor,Background;public string Menu,Name;public IntPtr SmallIcon;}
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW",SetLastError=true)] static extern IntPtr GetWindowLong(IntPtr h,int index);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern ushort RegisterClassEx(ref WindowClass c);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern int GetMessage(out Message message,IntPtr window,uint min,uint max);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool PeekMessage(out Message message,IntPtr window,uint min,uint max,uint flags);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
  [DllImport("user32.dll",SetLastError=true)] static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool UnregisterClass(string name,IntPtr instance);
  [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint color);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  static readonly List<object> Positions=new List<object>();
  static string Phase="create";
  static Dictionary<string,object> Map(params object[] values){var d=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)d.Add((string)values[i],values[i+1]);return d;}
  static long Now(){return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();}
  static void Save(string path,object value){File.WriteAllText(path,new JavaScriptSerializer().Serialize(value),new UTF8Encoding(false));}
  static void Position(string edge,IntPtr h,uint m,IntPtr l){if((m!=0x46&&m!=0x47)||l==IntPtr.Zero)return;WindowPos p=(WindowPos)Marshal.PtrToStructure(l,typeof(WindowPos));Positions.Add(Map("atUnixMs",Now(),"phase",Phase,"edge",edge,"message",m,"hwnd",h.ToInt64(),"windowPos",Map("hwnd",p.Hwnd.ToInt64(),"insertAfter",p.InsertAfter.ToInt64(),"x",p.X,"y",p.Y,"width",p.Cx,"height",p.Cy,"flags",p.Flags)));}
  static IntPtr Procedure(IntPtr h,uint m,IntPtr w,IntPtr l){Position("before-DefWindowProc",h,m,l);IntPtr result=DefWindowProc(h,m,w,l);Position("after-DefWindowProc",h,m,l);if(m==2)PostQuitMessage(0);return result;}
  static object Window(IntPtr h){Rect r;SetLastError(0);bool rectOk=GetWindowRect(h,out r);int rectError=Marshal.GetLastWin32Error();SetLastError(0);long style=GetWindowLong(h,-20).ToInt64();int styleError=Marshal.GetLastWin32Error();return Map("hwnd",h.ToInt64(),"visible",IsWindowVisible(h),"iconic",IsIconic(h),"rectReturned",rectOk,"rectError",rectError,"rect",Map("x",r.Left,"y",r.Top,"width",r.Right-r.Left,"height",r.Bottom-r.Top),"extendedStyle",Map("value",style,"lastError",styleError,"topmost",(style&8)!=0));}
  static void Pump(int milliseconds){Stopwatch clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<milliseconds){Message m;while(PeekMessage(out m,IntPtr.Zero,0,0,1)){if(m.Id==0x12)throw new InvalidOperationException("Fixture quit before ready.");TranslateMessage(ref m);DispatchMessage(ref m);if(clock.ElapsedMilliseconds>=milliseconds)break;}Thread.Sleep(10);}}
  public static object Run(string readyPath,string cleanupPath,int x,int y,int width,int height){
    if(IntPtr.Size!=8)throw new InvalidOperationException("Requires 64-bit host.");
    if(width<21||height<21)throw new ArgumentOutOfRangeException("width","Fixture must include interior test points.");
    IntPtr hwnd=IntPtr.Zero,brush=IntPtr.Zero,instance=GetModuleHandle(null),previousDpi=IntPtr.Zero;bool registered=false,ready=false;WindowProc callback=Procedure;
    string className="KinshokoT17RawCreate_"+Process.GetCurrentProcess().Id+"_"+Guid.NewGuid().ToString("N");
    var output=Map("schema",1,"status","starting","pid",Process.GetCurrentProcess().Id,"className",className,"beginUnixMs",Now());
    try{
      SetLastError(0);previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));int dpiError=Marshal.GetLastWin32Error();output.Add("dpi",Map("previous",previousDpi.ToInt64(),"lastError",dpiError));if(previousDpi==IntPtr.Zero)throw new InvalidOperationException("Per-monitor DPI context was not established.");
      brush=CreateSolidBrush(0x00e51103);if(brush==IntPtr.Zero)throw new InvalidOperationException("CreateSolidBrush failed.");
      WindowClass c=new WindowClass();c.Size=(uint)Marshal.SizeOf(typeof(WindowClass));c.Proc=Marshal.GetFunctionPointerForDelegate(callback);c.Instance=instance;c.Background=brush;c.Name=className;
      SetLastError(0);ushort atom=RegisterClassEx(ref c);int classError=Marshal.GetLastWin32Error();output.Add("registration",Map("atom",atom,"lastError",classError));if(atom==0)throw new InvalidOperationException("RegisterClassEx failed.");registered=true;
      var createArgs=Map("api","CreateWindowExW","extendedStyle",0x40008,"className",className,"title","Kinshoko owned T17 raw create-topmost fixture","style",0x80000000u,"x",x,"y",y,"width",width,"height",height,"parentHwnd",0,"menu",0,"instance",instance.ToInt64(),"parameter",0);
      Phase="single-create-topmost";long createBegin=Now();SetLastError(0);hwnd=CreateWindowEx(0x40008,className,"Kinshoko owned T17 raw create-topmost fixture",0x80000000,x,y,width,height,IntPtr.Zero,IntPtr.Zero,instance,IntPtr.Zero);int createError=Marshal.GetLastWin32Error();long createEnd=Now();
      var creation=Map("arguments",createArgs,"beginUnixMs",createBegin,"endUnixMs",createEnd,"hwnd",hwnd.ToInt64(),"lastError",createError,"explicitCallCount",1);output.Add("creation",creation);if(hwnd==IntPtr.Zero)throw new InvalidOperationException("CreateWindowEx failed.");creation.Add("afterCreation",Window(hwnd));
      Phase="single-show";long showBegin=Now();bool previouslyVisible=ShowWindow(hwnd,4);long showEnd=Now();var show=Map("api","ShowWindow","command",4,"explicitCallCount",1,"beginUnixMs",showBegin,"endUnixMs",showEnd,"returnedPreviouslyVisible",previouslyVisible,"returnScope","ShowWindow return describes prior visibility; actual visible state is measured separately.","afterShow",Window(hwnd));output.Add("show",show);
      Phase="post-show-pump";Pump(100);object afterPump=Window(hwnd);Phase="delayed-observation";Pump(150);object delayed=Window(hwnd);
      var report=Map("schema",1,"status","ready","pid",Process.GetCurrentProcess().Id,"hwnd",hwnd.ToInt64(),"className",className,"previousDpiContext",previousDpi.ToInt64(),"creation",creation,"show",show,"afterPump100ms",afterPump,"delayedAfter150ms",delayed,"explicitSetWindowPosCalls",0,"positionMessages",Positions.ToArray());
      Save(readyPath,report);ready=true;output.Add("ready",report);Phase="message-loop";
      for(;;){Message m;SetLastError(0);int got=GetMessage(out m,IntPtr.Zero,0,0);int getError=Marshal.GetLastWin32Error();if(got==0)break;if(got==-1)throw new InvalidOperationException("GetMessage failed: "+getError);TranslateMessage(ref m);DispatchMessage(ref m);}
      output["status"]="closed";
    }catch(Exception ex){output["status"]="failed";output.Add("error",Map("type",ex.GetType().FullName,"message",ex.Message));if(!ready)Save(readyPath,output);}
    finally{
      Phase="cleanup";var cleanup=new Dictionary<string,object>();if(hwnd!=IntPtr.Zero&&IsWindow(hwnd)){SetLastError(0);bool destroyed=DestroyWindow(hwnd);int error=Marshal.GetLastWin32Error();cleanup.Add("destroy",Map("returned",destroyed,"lastError",error));}cleanup.Add("hwnd",hwnd.ToInt64());cleanup.Add("stillWindow",hwnd!=IntPtr.Zero&&IsWindow(hwnd));
      if(registered){SetLastError(0);bool removed=UnregisterClass(className,instance);int error=Marshal.GetLastWin32Error();cleanup.Add("unregisterClass",Map("returned",removed,"lastError",error));cleanup.Add("brushOwnership","Registered class background brush is released by the system when the class is unregistered; no second DeleteObject call.");}
      else if(brush!=IntPtr.Zero)cleanup.Add("unregisteredBrushDeleted",DeleteObject(brush));
      if(previousDpi!=IntPtr.Zero){SetLastError(0);IntPtr prior=SetThreadDpiAwarenessContext(previousDpi);int error=Marshal.GetLastWin32Error();cleanup.Add("threadDpiRestored",Map("returnedPrevious",prior.ToInt64(),"lastError",error));}
      GC.KeepAlive(callback);output.Add("cleanup",cleanup);output.Add("positionMessages",Positions.ToArray());output.Add("endUnixMs",Now());Save(cleanupPath,output);
    }
    return output;
  }
}
