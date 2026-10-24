# 读 dwm.exe 与原型进程的 GPU 内存（任务管理器“专用／共享 GPU 内存”同一组计数器），以及整块显卡的专用显存。
# 用法：pwsh gpu-memory.ps1 [标签]
param([string]$Label = "")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$dwm = (Get-Process dwm).Id
$probe = (Get-Process kinshoko-native-pin-probe -ErrorAction SilentlyContinue | Select-Object -First 1).Id
$c = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage', '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples
function Sum($id, $kind) {
    if (-not $id) { return 0 }
    [math]::Round((($c | Where-Object { $_.Path -like "*gpu process memory(pid_$($id)_*)\$kind usage" }) | Measure-Object CookedValue -Sum).Sum / 1MB, 1)
}
$adapter = [math]::Round((($c | Where-Object { $_.Path -like '*gpu adapter memory*' }) | Measure-Object CookedValue -Sum).Sum / 1MB, 1)
$private = if ($probe) { [math]::Round((Get-Process -Id $probe).PrivateMemorySize64 / 1MB, 1) } else { 0 }
"$Label`tdwm 专用 $(Sum $dwm 'dedicated') MB 共享 $(Sum $dwm 'shared') MB`t原型 专用 $(Sum $probe 'dedicated') MB 共享 $(Sum $probe 'shared') MB 私有内存 $private MB`t显卡专用合计 $adapter MB"
