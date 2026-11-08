# 预先下载 tauri build 打 NSIS 安装包要用的工具，放到 Tauri 自己找的位置，tauri build 就不再现下载。
# 用法：pwsh scripts/release/fetch-tauri-nsis.ps1 -CliVersion 2.12.1
# 只在 CI 里由 .github/actions/tauri-nsis 在缓存未命中时调用。
#
# 2026-11-08 发 v1.1.0-beta.3 时，GitHub Release 附件对未认证请求反复返回 504，
# tauri build 自己下载（不重试）失败，发布构建重跑了 4 次。这里用带重试的 curl 下载。
#
# 下面的地址、SHA1 与必需文件取自 Tauri CLI 2.12.1 的打包器
# （crates/tauri-bundler/src/bundle/windows/nsis/mod.rs，标签 tauri-cli-v2.12.1）。打包器的逻辑：
# 工具目录是 dirs::cache_dir()/tauri/NSIS，即 %LOCALAPPDATA%\tauri\NSIS（tauri.conf.json 没开 useLocalToolsDir）；
# 目录不存在或缺必需文件就整个重新下载，nsis_tauri_utils.dll 的 SHA1 不对就重新下载它；否则直接用。
# CLI 升级后先对照新版本的这个文件改下面几项和 $SourceCliVersion；没改时这里跳过预取，由 tauri build 自己下载。
param(
    [Parameter(Mandatory = $true)][string]$CliVersion,
    [string]$ToolsDir = (Join-Path $env:LOCALAPPDATA 'tauri')
)
$ErrorActionPreference = 'Stop'

$SourceCliVersion = '2.12.1'
$NsisUrl = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'
$NsisSha1 = 'EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D'
$NsisFolder = 'nsis-3.11'
$UtilsUrl = 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
$UtilsSha1 = '75197FEE3C6A814FE035788D1C34EAD39349B860'
$RequiredFiles = @(
    'makensis.exe',
    'Bin/makensis.exe',
    'Stubs/lzma-x86-unicode',
    'Stubs/lzma_solid-x86-unicode',
    'Plugins/x86-unicode/additional/nsis_tauri_utils.dll',
    'Include/MUI2.nsh',
    'Include/FileFunc.nsh',
    'Include/x64.nsh',
    'Include/nsDialogs.nsh',
    'Include/WinMessages.nsh',
    'Include/Win/COM.nsh',
    'Include/Win/Propkey.nsh',
    'Include/Win/RestartManager.nsh'
)

if ($CliVersion -ne $SourceCliVersion) {
    Write-Host "::warning::Tauri CLI 是 $CliVersion，预取脚本按 $SourceCliVersion 写的：跳过预取，由 tauri build 自己下载 NSIS。对照新版本打包器更新 scripts/release/fetch-tauri-nsis.ps1。"
    exit 0
}

function Get-Verified([string]$Url, [string]$Sha1, [string]$OutFile) {
    # --retry-all-errors：504 这类服务端错误也重试（默认只重试连接失败和部分状态码）。
    $curlArgs = @('--fail', '--location', '--silent', '--show-error',
        '--retry', '5', '--retry-all-errors', '--retry-delay', '10',
        '--connect-timeout', '30', '--max-time', '300',
        '--output', $OutFile, $Url)
    & curl.exe @curlArgs
    if ($LASTEXITCODE -ne 0) { throw "下载失败（curl 退出码 $LASTEXITCODE）：$Url" }
    $actual = (Get-FileHash -Algorithm SHA1 $OutFile).Hash
    if ($actual -ne $Sha1) { throw "SHA1 不符：$Url 期望 $Sha1，实际 $actual" }
    Write-Host "已下载并校验：$Url"
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("tauri-nsis-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $work | Out-Null
try {
    $zip = Join-Path $work 'nsis.zip'
    $dll = Join-Path $work 'nsis_tauri_utils.dll'
    Get-Verified $NsisUrl $NsisSha1 $zip
    Get-Verified $UtilsUrl $UtilsSha1 $dll

    $extracted = Join-Path $work 'extracted'
    Expand-Archive -Path $zip -DestinationPath $extracted
    $nsis = Join-Path $ToolsDir 'NSIS'
    if (Test-Path $nsis) { Remove-Item -Recurse -Force $nsis }
    New-Item -ItemType Directory -Force $ToolsDir | Out-Null
    Move-Item (Join-Path $extracted $NsisFolder) $nsis
    $additional = Join-Path $nsis 'Plugins/x86-unicode/additional'
    New-Item -ItemType Directory -Force $additional | Out-Null
    Copy-Item $dll (Join-Path $additional 'nsis_tauri_utils.dll')

    $missing = $RequiredFiles | Where-Object { -not (Test-Path (Join-Path $nsis $_)) }
    if ($missing) { throw "NSIS 目录缺少：$($missing -join ', ')" }
    Write-Host "NSIS 工具已放到 $nsis"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
