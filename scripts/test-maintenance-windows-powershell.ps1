param([string]$MaintenanceRoot=$PSScriptRoot,[string]$OutputRoot='artifacts/readiness-maintenance')
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1){throw 'Run this regression using Windows PowerShell 5.1.'}
$project=Split-Path $PSScriptRoot
$root=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot))
$install=Join-Path $root ('中文安装-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory((Join-Path $install 'data'))|Out-Null
$sentinel=Join-Path $install 'data/保留.txt';[IO.File]::WriteAllText($sentinel,'KEEP SYNTHETIC DATA')
function SaveManifest($release,$manifest){[IO.File]::WriteAllText((Join-Path $release 'release-manifest.json'),($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))}
function Verify($release){& (Join-Path $MaintenanceRoot 'verify.ps1') -ReleaseRoot $release}
function MustReject($release,$label){$rejected=$false;try{Verify $release|Out-Null}catch{$rejected=$true};if(-not $rejected){throw "Accepted $label"}}
foreach($version in @('old','new')){
 $release=Join-Path $install ('releases/'+$version);[IO.Directory]::CreateDirectory($release)|Out-Null
 $names=@('UnifiedMediaHub.exe','worker/src/main.mjs','runtime/node/node.exe','runtime/browsers/chromium-1248/chrome-win64/chrome.exe','runtime/engines/gallery-dl/gallery-dl.exe','runtime/engines/tdl/tdl.exe','docs/usage.md','docs/中文说明.md');$entries=@()
 foreach($name in $names){$p=Join-Path $release $name;[IO.Directory]::CreateDirectory((Split-Path $p -Parent))|Out-Null;[IO.File]::WriteAllText($p,'SYNTHETIC NONEXECUTABLE '+$version);$entries+=@{path=$name;bytes=(Get-Item -LiteralPath $p).Length;sha256=(Get-FileHash -LiteralPath $p).Hash}}
 $manifest=@{schemaVersion=1;releaseId=$version;entryPoint=$names[0];workerScript=$names[1];nodeExecutable=$names[2];browserExecutable=$names[3];galleryDlExecutable=$names[4];tdlExecutable=$names[5];files=$entries}
 SaveManifest $release $manifest
 Verify $release|Out-Null
}
& (Join-Path $MaintenanceRoot 'activate.ps1') -Version old -InstallRoot $install|Out-Null
$link=Join-Path $install '统一媒体管理器.lnk';$pointer=Join-Path $install 'CURRENT.txt'
if(-not (Test-Path -LiteralPath $link)){throw 'Chinese shortcut filename was corrupted'}
$shell=New-Object -ComObject WScript.Shell;$actual=$shell.CreateShortcut($link)
if($actual.Description -ne '统一媒体管理器：离线预览，真实平台待验证' -or $actual.Arguments -ne ('--data-root "'+(Join-Path $install 'data')+'"')){throw 'Chinese shortcut metadata/path was corrupted'}
if(-not (Test-Path -LiteralPath (Join-Path $install '使用说明.md'))){throw 'Chinese usage filename was corrupted'}
$oldLink=(Get-FileHash -LiteralPath $link).Hash;$oldPointer=(Get-FileHash -LiteralPath $pointer).Hash
$failed=$false;try{& (Join-Path $MaintenanceRoot 'activate.ps1') -Version new -InstallRoot $install -InjectFailure after-shortcut|Out-Null}catch{$failed=$true}
if(-not $failed -or (Get-FileHash -LiteralPath $link).Hash -ne $oldLink -or (Get-FileHash -LiteralPath $pointer).Hash -ne $oldPointer){throw 'Interrupted activation did not roll back'}
& (Join-Path $MaintenanceRoot 'activate.ps1') -Version new -InstallRoot $install|Out-Null
& (Join-Path $MaintenanceRoot 'activate.ps1') -Version old -InstallRoot $install|Out-Null
if((Get-Content -LiteralPath $pointer -Raw -Encoding UTF8).Trim() -ne 'old' -or (Get-Content -LiteralPath $sentinel -Raw) -ne 'KEEP SYNTHETIC DATA'){throw 'Manual rollback or data preservation failed'}
$release=Join-Path $install 'releases/new';$manifest=Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
$extra=Join-Path $release 'unexpected.txt';[IO.File]::WriteAllText($extra,'extra');MustReject $release 'extra file';[IO.File]::Delete($extra)
$original=$manifest.files[0].path;$manifest.files[0].path='../data/保留.txt';SaveManifest $release $manifest;MustReject $release 'manifest boundary escape';$manifest.files[0].path=$original;SaveManifest $release $manifest
$target=Join-Path $install 'synthetic-link-target';[IO.Directory]::CreateDirectory($target)|Out-Null
New-Item -ItemType Junction -Path (Join-Path $release 'unexpected-link') -Target $target|Out-Null
MustReject $release 'reparse directory'
# Remove only this newly created junction, never recurse into its target.
[IO.Directory]::Delete((Join-Path $release 'unexpected-link'))
[IO.File]::AppendAllText((Join-Path $release 'UnifiedMediaHub.exe'),'corrupt');MustReject $release 'corrupt file'
$result=@{status='PASS';runtime=$PSVersionTable.PSVersion.ToString();clr=[Environment]::Version.ToString();chinesePathsAndUtf8=$true;interruptedRollback=$true;manualRollback=$true;dataPreserved=$true;extraFileRejected=$true;boundaryEscapeRejected=$true;reparseRejected=$true;corruptionRejected=$true;syntheticInstall=$install}
$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding UTF8
$result|ConvertTo-Json
