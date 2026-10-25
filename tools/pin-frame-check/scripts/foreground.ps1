# 打印当前前台窗口的进程名、类名与是否最大化，以及测试用 Edge 主窗口的状态（诊断 Edge 被判为隐藏的原因）。
param([string]$Profile)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
}
"@
$fg = [W]::GetForegroundWindow(); $fpid = 0; [void][W]::GetWindowThreadProcessId($fg, [ref]$fpid)
$sb = New-Object Text.StringBuilder 128; [void][W]::GetClassName($fg, $sb, 128)
$fname = (Get-Process -Id $fpid -ErrorAction SilentlyContinue).ProcessName
$edge = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$Profile*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
$eh = (Get-Process -Id $edge.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle
"前台=$fname/$($sb.ToString())`t前台是测试Edge=$($fpid -eq $edge.ProcessId)`tEdge最小化=$([W]::IsIconic($eh))`tEdge最大化=$([W]::IsZoomed($eh))"
