param([Parameter(Mandatory)][string]$Version,[string]$AppStage='artifacts/current-app',[Parameter(Mandatory)][string]$InstallRoot,[switch]$Activate,[ValidateSet('none','after-shortcut')][string]$InjectFailure='none')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot
if($Version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'){throw 'Invalid version.'}
$install=[IO.Path]::GetFullPath($InstallRoot)
if($install.StartsWith('\\')){throw 'Install root must be local.'}
function Plain([string]$p){$current=$p;while($current){if(Test-Path -LiteralPath $current){if((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse destination rejected.'}};$next=Split-Path $current -Parent;if($next -eq $current){break};$current=$next}}
Plain $install
$mitNotices=@(
 @{source='.cache/nuget/microsoft.netcore.app.runtime.win-x64/10.0.13/LICENSE.TXT';relative='notices/nuget/MIT-Microsoft-NETCore.txt'},
 @{source='.cache/nuget/microsoft.windowsdesktop.app.runtime.win-x64/10.0.13/LICENSE';relative='notices/nuget/MIT-Microsoft-WindowsDesktop.txt'}
)
# Fail before creating release state or copying payloads if the pinned runtime
# terms no longer match the notice name. This is a packaging provenance gate.
foreach($notice in $mitNotices){
 $source=Join-Path $project $notice.source;Plain $source
 if((Get-Content -LiteralPath $source -TotalCount 1) -cne 'The MIT License (MIT)'){throw 'Pinned runtime license is not MIT; packaging stopped before destination changes.'}
}
$versions=Join-Path $install 'releases';[IO.Directory]::CreateDirectory($versions)|Out-Null
$final=Join-Path $versions $Version
if(Test-Path -LiteralPath $final){throw 'Version already exists; never overwrite releases.'}
$stage=Join-Path $versions ('.staging-'+$Version+'-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($stage)|Out-Null
function CopyPublic([string]$source,[string]$relative){
 if(-not [IO.Path]::IsPathRooted($source)){$source=Join-Path $project $source};$source=[IO.Path]::GetFullPath($source);Plain $source
 $dest=Join-Path $stage $relative
 [IO.Directory]::CreateDirectory((Split-Path $dest -Parent))|Out-Null
 if((Get-Item -LiteralPath $source).PSIsContainer){Get-ChildItem -LiteralPath $source -Recurse -Force|ForEach-Object {if($_.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Public source contains reparse point.'}};[IO.Directory]::CreateDirectory($dest)|Out-Null;Get-ChildItem -LiteralPath $source -Force|ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse}}
 else {Copy-Item -LiteralPath $source -Destination $dest}
}
$app=if([IO.Path]::IsPathRooted($AppStage)){[IO.Path]::GetFullPath($AppStage)}else{[IO.Path]::GetFullPath((Join-Path $project $AppStage))}
Get-ChildItem -LiteralPath $app -File|Where-Object Extension -ne '.pdb'|ForEach-Object {CopyPublic $_.FullName $_.Name}
foreach($p in @('worker/src','worker/package.json','worker/package-lock.json','worker/THIRD-PARTY-ENGINE-NOTICES.txt','worker/node_modules/playwright','worker/node_modules/playwright-core','runtime/browsers/chromium-1248')){CopyPublic $p $p}
foreach($p in @('runtime/node/node.exe','runtime/node/LICENSE','runtime/engines/gallery-dl/gallery-dl.exe','runtime/engines/gallery-dl/LICENSE','runtime/engines/tdl/tdl.exe','runtime/engines/tdl/LICENSE')){CopyPublic $p $p}
foreach($p in @('docs/usage.md','docs/capabilities.md','docs/third-party-notices.md')){CopyPublic $p $p}
foreach($name in @('chrome-credits.html','chrome-credits.txt','chrome-terms.html','chrome-terms.txt')){CopyPublic ('artifacts/third-party/browser-notices/'+$name) ('notices/browser/'+$name)}
foreach($name in @('activate.ps1','verify.ps1')){CopyPublic ('scripts/'+$name) ('maintenance/'+$name)}
CopyPublic 'runtime/browsers/chromium-1248/chrome-win64/ABOUT' 'notices/browser/ABOUT'
CopyPublic 'artifacts/third-party/tdl/tdl-v0.20.4+umh.6-source.zip' 'notices/tdl/tdl-v0.20.4+umh.6-source.zip'
foreach($name in @('README.md','upstream.json','overlay-manifest.json','upstream.patch')){CopyPublic ('engines/tdl/'+$name) ('notices/tdl/'+$name)}
CopyPublic 'engines/tdl/README.md' 'runtime/engines/tdl/README-UMH.md'
foreach($name in @('gallery_dl-1.32.20.tar.gz','SHA256SUMS','provenance.json')){CopyPublic ('artifacts/third-party/gallery-dl/'+$name) ('notices/gallery-dl/'+$name)}
foreach($name in @('LICENSE.txt','ThirdPartyNotices.txt')){CopyPublic ('.tooling/dotnet/'+$name) ('notices/dotnet/'+$name)}
# Carry exact package attribution/license metadata without duplicate runtime archives.
$deps=Get-Content (Join-Path $project 'src/UnifiedMediaHub.Core/obj/project.assets.json') -Raw -Encoding UTF8|ConvertFrom-Json
foreach($dep in $deps.libraries.PSObject.Properties.Name){$pair=$dep.ToLowerInvariant().Split('/');$folder=Join-Path $project ('.cache/nuget/'+$pair[0]+'/'+$pair[1]);Get-ChildItem -LiteralPath $folder -File|Where-Object {$_.Name -match '\.nuspec$|license|notice|copyright|package\.md'}|ForEach-Object {CopyPublic $_.FullName ('notices/nuget/'+$dep+'/'+$_.Name)}}
CopyPublic 'worker/node_modules/playwright/LICENSE' 'notices/nuget/Apache-2.0.txt'
foreach($notice in $mitNotices){CopyPublic $notice.source $notice.relative}
CopyPublic '.tooling/dotnet/LICENSE.txt' 'notices/nuget/Microsoft-.NET-Library-License.txt'
$sourceIndex=[ordered]@{node='https://nodejs.org/dist/v22.23.3/';playwright='https://github.com/microsoft/playwright/tree/v1.64.1';browser='https://cdn.playwright.dev/builds/cft/156.0.8078.4/win64/chrome-win64.zip';galleryDl='https://codeberg.org/mikf/gallery-dl/releases/tag/v1.32.20';tdl='https://github.com/iyear/tdl/tree/v0.20.4';tdlModifiedSource='tdl/tdl-v0.20.4+umh.6-source.zip';sdk='https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.zip';scope='Personal local preview; exact notices and matching source supplied; no universal redistribution certification'}
$sourceIndex|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stage 'notices/source-index.json') -Encoding utf8
$entries=@(Get-ChildItem -LiteralPath $stage -File -Recurse|Sort-Object FullName|ForEach-Object {[ordered]@{path=$_.FullName.Substring($stage.TrimEnd('\').Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
[ordered]@{schemaVersion=1;releaseId=$Version;verification='offline-preview-live-pending';entryPoint='UnifiedMediaHub.exe';workerScript='worker/src/main.mjs';nodeExecutable='runtime/node/node.exe';browserExecutable='runtime/browsers/chromium-1248/chrome-win64/chrome.exe';engineRoot='runtime/engines';galleryDlExecutable='runtime/engines/gallery-dl/gallery-dl.exe';tdlExecutable='runtime/engines/tdl/tdl.exe';files=$entries}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $stage 'release-manifest.json') -Encoding utf8
& (Join-Path $PSScriptRoot 'verify.ps1') -ReleaseRoot $stage|Out-Host
[IO.Directory]::Move($stage,$final)
& (Join-Path $PSScriptRoot 'verify.ps1') -ReleaseRoot $final|Out-Host
if($Activate){ & (Join-Path $PSScriptRoot 'activate.ps1') -Version $Version -InstallRoot $install -InjectFailure $InjectFailure | Out-Host }
Write-Output $final
