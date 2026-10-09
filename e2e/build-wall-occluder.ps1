param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory)
$taskSource=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'native-wall-occluder.cs')).Path
New-Item -ItemType Directory -Path $taskOutput -Force|Out-Null
$taskDll=Join-Path $taskOutput 'native-wall-occluder.dll'
if(Test-Path -LiteralPath $taskDll){throw 'Refuse to replace an existing frozen helper assembly.'}
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $taskCompiler /nologo /target:library "/out:$taskDll" /reference:System.Web.Extensions.dll $taskSource > (Join-Path $taskOutput 'compile-stdout.txt') 2> (Join-Path $taskOutput 'compile-stderr.txt')
$taskExit=$LASTEXITCODE
[ordered]@{compileOnly=$true;executed=$false;sourcePath=$taskSource;sourceSha256=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash;compiler=$taskCompiler;exitCode=$taskExit;dll=$taskDll;dllSha256=if(Test-Path -LiteralPath $taskDll){(Get-FileHash -LiteralPath $taskDll -Algorithm SHA256).Hash}else{$null}}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $taskOutput 'compile-metadata.json') -Encoding UTF8
if($taskExit){exit $taskExit}
