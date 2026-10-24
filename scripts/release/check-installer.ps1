# 静默安装 NSIS 安装包到临时目录，确认应用 exe 与 DirectML.dll 都装上了，再静默卸载（#70）。
# 用法：pwsh scripts/release/check-installer.ps1 target/release/bundle/nsis/Kinshoko_0.1.0_x64-setup.exe
# 安装包按用户安装（currentUser），不需要管理员权限；这里不检查 UAC，只检查装出来的文件。
param(
    [Parameter(Mandatory = $true)][string]$Installer
)
$ErrorActionPreference = 'Stop'

$dir = Join-Path ([System.IO.Path]::GetTempPath()) ("kinshoko-installer-check-" + [guid]::NewGuid())
try {
    $p = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList '/S', "/D=$dir" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "安装程序退出码 $($p.ExitCode)" }

    $missing = @('kinshoko.exe', 'DirectML.dll', 'uninstall.exe') |
        Where-Object { -not (Test-Path (Join-Path $dir $_)) }
    if ($missing) {
        Get-ChildItem $dir | Format-Table Name, Length | Out-String | Write-Host
        throw "安装目录缺少：$($missing -join '、')"
    }
    Write-Host "安装包检查通过：kinshoko.exe 与 DirectML.dll 都在安装目录。"
}
finally {
    $uninstaller = Join-Path $dir 'uninstall.exe'
    if (Test-Path $uninstaller) {
        # _?= 让卸载程序在原地运行并等它结束；卸载后目录里应不剩文件。
        Start-Process -FilePath $uninstaller -ArgumentList '/S', "_?=$dir" -Wait | Out-Null
        $left = Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne 'uninstall.exe' }
        if ($left) { Write-Warning "卸载后仍有文件：$($left.Name -join '、')" }
    }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
}
