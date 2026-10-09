$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class T17FixtureNative { [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value); [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags); }'
$dpiContext=[T17FixtureNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f=New-Object System.Windows.Forms.Form
$f.AutoScaleMode='None'
$f.FormBorderStyle='None'
$f.StartPosition='Manual'
$f.Location=New-Object System.Drawing.Point(1130,848)
$f.ClientSize=New-Object System.Drawing.Size(61,51)
$f.TopMost=$true
$f.BackColor=[System.Drawing.Color]::FromArgb(3,17,229)
$f.Add_Shown({$placed=[T17FixtureNative]::SetWindowPos($f.Handle,[IntPtr]::new(-1),1130,848,61,51,0x50);if(!$placed){throw 'Owned fixture placement failed'};$ready=@{pid=$PID;hwnd=$f.Handle.ToInt64();placed=$placed;previousDpiContext=$dpiContext.ToInt64()};[IO.File]::WriteAllText('C:\Users\yuk1no\.codex\worktrees\spec78-t16-original-crop\kinshoko\work\e2e\wall-capture-1791501732795\occluder-ready.json',($ready|ConvertTo-Json -Compress))})
[System.Windows.Forms.Application]::Run($f)
