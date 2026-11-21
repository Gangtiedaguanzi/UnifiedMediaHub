param([string]$OutputRoot='artifacts/stage-a-20261108/license-gate')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot
$output=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot))
$allowed=[IO.Path]::GetFullPath((Join-Path $project 'artifacts'))+'\'
if(-not $output.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Test output must stay in this project artifacts.'}
$run=Join-Path $output ([Guid]::NewGuid().ToString('N'))
$scripts=Join-Path $run 'scripts';$app=Join-Path $run 'empty-app';$install=Join-Path $run 'install'
foreach($directory in @($scripts,$app,(Join-Path $run '.cache/nuget/microsoft.netcore.app.runtime.win-x64/10.0.13'),(Join-Path $run '.cache/nuget/microsoft.windowsdesktop.app.runtime.win-x64/10.0.13'))){[IO.Directory]::CreateDirectory($directory)|Out-Null}
Copy-Item -LiteralPath (Join-Path $project 'scripts/package.ps1') -Destination (Join-Path $scripts 'package.ps1')
[IO.File]::WriteAllText((Join-Path $run '.cache/nuget/microsoft.netcore.app.runtime.win-x64/10.0.13/LICENSE.TXT'),'Synthetic incompatible license')
[IO.File]::WriteAllText((Join-Path $run '.cache/nuget/microsoft.windowsdesktop.app.runtime.win-x64/10.0.13/LICENSE'),"The MIT License (MIT)")
$rejected=$false
try{& (Join-Path $scripts 'package.ps1') -Version 'synthetic-bad-license' -AppStage $app -InstallRoot $install|Out-Null}catch{$rejected=$true}
$wroteRelease=Test-Path -LiteralPath (Join-Path $install 'releases')
if(-not $rejected -or $wroteRelease){throw 'License preflight must reject incompatible terms before creating any release state.'}
$result=[ordered]@{status='pass';incompatibleTermsRejected=$rejected;releaseStateWritten=$wroteRelease;fixture=$run;realInstallTouched=$false}
$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $run 'result.json') -Encoding utf8
$result|ConvertTo-Json
