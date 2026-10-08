# Operates only the observed Save dialog belonging to the frozen T18 executable.
param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$taskExe = [System.IO.Path]::GetFullPath($Executable)
$taskDestination = [System.IO.Path]::GetFullPath($Destination)
$taskWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskEvidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $taskWorkspace 'work/e2e')) + [System.IO.Path]::DirectorySeparatorChar
if (-not $taskDestination.StartsWith($taskEvidenceRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must be in this T18 evidence directory' }
$taskManifest = Get-Content -LiteralPath (Join-Path $taskWorkspace 'work/t18/native-source.json') -Raw | ConvertFrom-Json
if ($taskExe -ne $taskManifest.preservedBinary -or (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskManifest.binarySha256) { throw 'Unmatched frozen executable' }
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
$taskControls = @($taskAll | ForEach-Object { @{ name=$_.Current.Name; id=$_.Current.AutomationId; type=$_.Current.ControlType.ProgrammaticName } })
$taskEdits = @($taskAll | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and ($_.Current.AutomationId -eq '1001' -or $_.Current.Name -match '文件名|File name') })
if ($taskEdits.Count -ne 1) { throw ('Cannot uniquely identify filename edit: ' + ($taskControls | ConvertTo-Json -Compress)) }
$taskEditPattern = $taskEdits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$taskEditPattern.SetValue($taskDestination)
$taskButtons = @($taskAll | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.AutomationId -eq '1' })
if ($taskButtons.Count -ne 1) { throw ('Cannot uniquely identify Save button: ' + ($taskControls | ConvertTo-Json -Compress)) }
$taskReceipt = @{ pid=$taskProcessId; dialog=$taskDialog.Current.Name; filenameEdit=@{name=$taskEdits[0].Current.Name;id=$taskEdits[0].Current.AutomationId}; saveButton=@{name=$taskButtons[0].Current.Name;id=$taskButtons[0].Current.AutomationId}; destination=$taskDestination; controls=$taskControls }
$taskButtons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
$taskReceipt | ConvertTo-Json -Depth 5
