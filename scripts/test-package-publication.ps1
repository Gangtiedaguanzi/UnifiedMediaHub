param([string]$MaintenanceRoot=$PSScriptRoot,[string]$OutputRoot='artifacts/task6-publication')
$ErrorActionPreference='Stop';$project=Split-Path $PSScriptRoot;$root=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot));[IO.Directory]::CreateDirectory($root)|Out-Null
$install=Join-Path $root ('synthetic-install-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory((Join-Path $install 'data'))|Out-Null;[IO.File]::WriteAllText((Join-Path $install 'data/sentinel'),'keep')
foreach($version in @('old','new')){
 $release=Join-Path $install ('releases/'+$version);[IO.Directory]::CreateDirectory($release)|Out-Null
 $names=@('UnifiedMediaHub.exe','worker/src/main.mjs','runtime/node/node.exe','runtime/browsers/chromium-1248/chrome-win64/chrome.exe','runtime/engines/gallery-dl/gallery-dl.exe','runtime/engines/tdl/tdl.exe','docs/usage.md');$entries=@()
 foreach($name in $names){$p=Join-Path $release $name;[IO.Directory]::CreateDirectory((Split-Path $p -Parent))|Out-Null;[IO.File]::WriteAllText($p,'SYNTHETIC NONEXECUTABLE '+$version);$entries+=@{path=$name;bytes=(Get-Item -LiteralPath $p).Length;sha256=(Get-FileHash -LiteralPath $p).Hash}}
 @{schemaVersion=1;releaseId=$version;entryPoint=$names[0];workerScript=$names[1];nodeExecutable=$names[2];browserExecutable=$names[3];galleryDlExecutable=$names[4];tdlExecutable=$names[5];files=$entries}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Encoding utf8
}
& (Join-Path $MaintenanceRoot 'activate.ps1') -Version old -InstallRoot $install|Out-Host
$link=Join-Path $install '统一媒体管理器.lnk';$pointer=Join-Path $install 'CURRENT.txt';$oldLink=(Get-FileHash -LiteralPath $link).Hash;$oldPointer=(Get-FileHash -LiteralPath $pointer).Hash
$failed=$false;try{& (Join-Path $MaintenanceRoot 'activate.ps1') -Version new -InstallRoot $install -InjectFailure after-shortcut|Out-Host}catch{$failed=$true}
if(-not $failed -or (Get-FileHash -LiteralPath $link).Hash -ne $oldLink -or (Get-FileHash -LiteralPath $pointer).Hash -ne $oldPointer){throw 'Publication rollback failed.'}
if((Get-Content -LiteralPath (Join-Path $install 'data/sentinel') -Raw) -ne 'keep'){throw 'Data changed during publication.'}
$release=Join-Path $install 'releases/new';$target=Join-Path $release 'UnifiedMediaHub.exe';[IO.File]::AppendAllText($target,'corrupt')
$rejected=$false;try{& (Join-Path $MaintenanceRoot 'verify.ps1') -ReleaseRoot $release|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'Corrupt package accepted.'}
@{evidence='Synthetic nonexecuting release trees; real activation scripts';rollbackPassed=$true;dataPreserved=$true;corruptionRejected=$true;path=$install}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'publication-results.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $root 'publication-results.json')
