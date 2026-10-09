# Operates only the observed Save dialog belonging to the frozen T18 executable.
param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$taskExe = [System.IO.Path]::GetFullPath($Executable)
$taskDestination = [System.IO.Path]::GetFullPath($Destination)
$taskWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskEvidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $taskWorkspace 'work/e2e')) + [System.IO.Path]::DirectorySeparatorChar
if (-not $taskDestination.StartsWith($taskEvidenceRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must be in this T18 evidence directory' }
$taskManifest = Get-Content -LiteralPath (Join-Path $taskWorkspace 'work/t18/native-source.json') -Raw | ConvertFrom-Json
$taskHashing = [System.Security.Cryptography.SHA256]::Create()
$taskExeStream = [System.IO.File]::OpenRead($taskExe)
try { $taskExeHash = [System.BitConverter]::ToString($taskHashing.ComputeHash($taskExeStream)).Replace('-', '').ToLowerInvariant() }
finally { $taskExeStream.Dispose(); $taskHashing.Dispose() }
if ($taskExe -ne $taskManifest.preservedBinary -or $taskExeHash -ne $taskManifest.binarySha256) { throw 'Unmatched frozen executable' }
$taskProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExe })
if ($taskProcesses.Count -ne 1) { throw 'Exactly one owned T18 process is required' }
$taskProcessId = [int]$taskProcesses[0].ProcessId
$taskRoot = [System.Windows.Automation.AutomationElement]::RootElement
$taskCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $taskProcessId)
$taskDeadline = [DateTime]::UtcNow.AddSeconds(15)
$taskDialog = $null
while ([DateTime]::UtcNow -lt $taskDeadline -and $null -eq $taskDialog) {
  $taskWindows = $taskRoot.FindAll([System.Windows.Automation.TreeScope]::Children, $taskCondition)
  foreach ($taskWindow in $taskWindows) {
    if ($taskWindow.Current.ClassName -eq '#32770') { if ($null -ne $taskDialog) { throw 'Ambiguous owned dialogs' }; $taskDialog = $taskWindow }
  }
  if ($null -eq $taskDialog) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $taskDialog) { throw 'No owned Save dialog appeared' }
$taskAll = $taskDialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$taskControls = @($taskAll | ForEach-Object { @{ id=$_.Current.AutomationId; type=$_.Current.ControlType.ProgrammaticName; class=$_.Current.ClassName; hwnd=$_.Current.NativeWindowHandle; patterns=@($_.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) } })
$taskFileHosts = @($taskAll | Where-Object { $_.Current.AutomationId -eq 'FileNameControlHost' })
if ($taskFileHosts.Count -ne 1) { throw 'Cannot uniquely identify observed filename host' }
$taskFileId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
$taskEdits = @($taskFileHosts[0].FindAll([System.Windows.Automation.TreeScope]::Descendants, $taskFileId))
if ($taskEdits.Count -ne 1) { throw ('Cannot uniquely identify filename edit: ' + ($taskControls | ConvertTo-Json -Compress)) }
$taskButtons = @($taskAll | Where-Object { $_.Current.AutomationId -eq '1' -and $_.Current.ClassName -eq 'Button' })
if ($taskButtons.Count -ne 1) { throw ('Cannot uniquely identify Save button: ' + ($taskControls | ConvertTo-Json -Compress)) }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class T18SaveControls {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)] public static extern IntPtr GetTextMessage(IntPtr hwnd, uint message, UIntPtr length, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wparam, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendButtonMessage(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
}
'@
function Assert-TaskControl($taskElement, [string]$taskExpectedClass, [int]$taskExpectedId) {
  $taskHwnd = [IntPtr]([long]$taskElement.Current.NativeWindowHandle)
  [uint32]$taskOwner = 0
  [void][T18SaveControls]::GetWindowThreadProcessId($taskHwnd, [ref]$taskOwner)
  $taskClass = [System.Text.StringBuilder]::new(256)
  [void][T18SaveControls]::GetClassName($taskHwnd, $taskClass, $taskClass.Capacity)
  if ($taskHwnd -eq [IntPtr]::Zero -or $taskOwner -ne $taskProcessId -or $taskClass.ToString() -ne $taskExpectedClass -or [T18SaveControls]::GetDlgCtrlID($taskHwnd) -ne $taskExpectedId -or -not [T18SaveControls]::IsChild([IntPtr]([long]$taskDialog.Current.NativeWindowHandle), $taskHwnd)) { throw ('Unmatched observed native control: ' + ($taskControls | ConvertTo-Json -Compress)) }
  return $taskHwnd
}
$taskEditHwnd = Assert-TaskControl $taskEdits[0] 'Edit' 1001
$taskSaveHwnd = Assert-TaskControl $taskButtons[0] 'Button' 1
$taskPattern = $null
$taskEditMethod = 'ValuePattern'
if ($taskEdits[0].TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$taskPattern)) { $taskPattern.SetValue($taskDestination) }
else {
  $taskEditMethod = 'observed owned Edit WM_SETTEXT'
  [UIntPtr]$taskResult = [UIntPtr]::Zero
  if ([T18SaveControls]::SendMessageTimeout($taskEditHwnd, 0x000C, [UIntPtr]::Zero, $taskDestination, 2, 2000, [ref]$taskResult) -eq [IntPtr]::Zero -or $taskResult -eq [UIntPtr]::Zero) { throw 'Owned filename text write failed' }
}
$taskActualText = [System.Text.StringBuilder]::new(32768)
[UIntPtr]$taskReadResult = [UIntPtr]::Zero
if ([T18SaveControls]::GetTextMessage($taskEditHwnd, 0x000D, [UIntPtr]([uint32]$taskActualText.Capacity), $taskActualText, 2, 2000, [ref]$taskReadResult) -eq [IntPtr]::Zero) { throw 'Owned filename readback timed out' }
if ($taskActualText.ToString() -ne $taskDestination) { throw ('Owned filename readback differs; actual length=' + $taskActualText.Length + ', expected length=' + $taskDestination.Length + ', method=' + $taskEditMethod) }
$taskReceipt = @{ pid=$taskProcessId; dialog=$taskDialog.Current.Name; filenameEdit=@{name=$taskEdits[0].Current.Name;id=$taskEdits[0].Current.AutomationId;hwnd=$taskEditHwnd.ToInt64();method=$taskEditMethod}; saveButton=@{name=$taskButtons[0].Current.Name;id=$taskButtons[0].Current.AutomationId;hwnd=$taskSaveHwnd.ToInt64()}; destination=$taskDestination; controls=$taskControls }
$taskPattern = $null
if ($taskButtons[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$taskPattern)) { $taskReceipt.saveButton.method='InvokePattern'; $taskPattern.Invoke() }
else {
  $taskReceipt.saveButton.method='observed owned Button BM_CLICK'
  [UIntPtr]$taskResult = [UIntPtr]::Zero
  if ([T18SaveControls]::SendButtonMessage($taskSaveHwnd, 0x00F5, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$taskResult) -eq [IntPtr]::Zero) { throw 'Owned Save button invocation failed' }
}
$taskReceipt | ConvertTo-Json -Depth 5
