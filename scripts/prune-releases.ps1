#Requires -Version 7.0
# PS7 required: Windows PowerShell 5.1 can miss directory named streams.
# Explicit, manual retention; never called by the application. Default is read-only.
param(
 [Parameter(Mandatory)][string]$InstallRoot,
 [Parameter(Mandatory)][string[]]$KeepVersions,
 [Parameter(Mandatory)][string[]]$RemoveVersions,
 [switch]$Apply
)
$ErrorActionPreference='Stop'
function Full([string]$p){
 if(![IO.Path]::IsPathRooted($p)-or $p.StartsWith('\\')){throw 'Absolute local path required'}
 $p=[IO.Path]::GetFullPath($p).TrimEnd('\')
 if($p.Length -le 3 -or $p.Substring(3).Contains(':')){throw 'Unsafe root path'}
 $p
}
function Plain([string]$p){
 $current=$p
 while($current){
  try{
   $attributes=[IO.File]::GetAttributes($current)
   if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse path rejected'}
  }catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{
   # New archive paths may not exist yet. Access/IO/other failures still stop.
  }
  $parent=[IO.Path]::GetDirectoryName($current);if($parent -eq $current){break};$current=$parent
 }
}
function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash}
$install=Full $InstallRoot;Plain $install
$releases=Join-Path $install 'releases';Plain $releases
$pointer=Join-Path $install 'CURRENT.txt';$shortcut=Join-Path $install '统一媒体管理器.lnk'
if($KeepVersions.Count -ne 2 -or @($KeepVersions|Sort-Object -Unique).Count -ne 2){throw 'Keep exactly two distinct verified releases'}
if(!$RemoveVersions.Count -or @($RemoveVersions|Sort-Object -Unique).Count -ne $RemoveVersions.Count){throw 'Explicit distinct removal list required'}
foreach($version in @($KeepVersions)+@($RemoveVersions)){
 if($version -notmatch '^0\.1\.0-preview\.[1-9][0-9]*$'){throw 'Unsupported release name'}
}
if(@($RemoveVersions|Where-Object {$_ -in $KeepVersions}).Count){throw 'Keep/remove overlap rejected'}
$shell=New-Object -ComObject WScript.Shell
function EntryPoint {
 Plain $pointer;Plain $shortcut
 $current=(Get-Content -LiteralPath $pointer -Raw -Encoding utf8).Trim()
 if($current -notin $KeepVersions){throw 'Current release is not protected'}
 $expected=Join-Path $releases $current;$link=$shell.CreateShortcut($shortcut)
 if($link.TargetPath -ne (Join-Path $expected 'UnifiedMediaHub.exe') -or $link.WorkingDirectory -ne $expected -or $link.Arguments -ne ('--data-root "'+(Join-Path $install 'data')+'"')){throw 'Shortcut and current pointer disagree'}
 $current
}
function NoProcesses {
 if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($releases+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Release process is running'}
}
function InspectVersion([string]$version){
 $path=Full (Join-Path $releases $version)
 if([IO.Path]::GetDirectoryName($path) -ne $releases){throw 'Removal path escaped release root'}
 Plain $path
 $manifestPath=Join-Path $path 'release-manifest.json'
 Plain $manifestPath
 $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8|ConvertFrom-Json
 if($manifest.releaseId -ne $version){throw 'Release identity mismatch'}
 $verified=& (Join-Path $PSScriptRoot 'verify.ps1') -ReleaseRoot $path
 # Do not remove unmanifested empty directories, streams, or adjacent user data.
 $directories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($entry in $manifest.files){
  $parent=[IO.Path]::GetDirectoryName((Full (Join-Path $path $entry.path)))
  while($parent -and $parent -ne $path){$null=$directories.Add($parent);$parent=[IO.Path]::GetDirectoryName($parent)}
 }
 foreach($item in @((Get-Item -LiteralPath $path -Force))+@(Get-ChildItem -LiteralPath $path -Recurse -Force)){
  Plain $item.FullName
  if($item.Attributes -band [IO.FileAttributes]::ReadOnly){throw 'Read-only release content rejected'}
  if($item.PSIsContainer -and $item.FullName -ne $path -and !$directories.Contains($item.FullName)){throw 'Unknown release directory rejected'}
  if(@(Get-Item -LiteralPath $item.FullName -Stream *|Where-Object {$_.Stream -ne ':$DATA'}).Count){throw 'Release named stream rejected'}
 }
 [pscustomobject]@{version=$version;path=$path;manifest=$manifestPath;manifestSha256=Hash $manifestPath;files=$verified.files;logicalBytes=$verified.bytes}
}
$lease=$null;$archive=$null;$removed=[Collections.Generic.List[string]]::new()
try{
 if($Apply){
  $key=[Environment]::UserDomainName+'\'+[Environment]::UserName+'|'+(Join-Path $install 'data').ToUpperInvariant()
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$digest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key))).Replace('-','')}finally{$sha.Dispose()}
  $created=$false;$lease=[Threading.Mutex]::new($false,('Local\UnifiedMediaHub-'+$digest),[ref]$created)
  if(!$created){throw 'Application data root is in use'}
  NoProcesses
 }
 $current=EntryPoint
 $kept=@($KeepVersions|ForEach-Object {InspectVersion $_})
 $candidates=@($RemoveVersions|ForEach-Object {InspectVersion $_})
 if($Apply){
  $archive=Join-Path (Join-Path $install 'docs-backups') ('retention-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N'))
  Plain $archive;[IO.Directory]::CreateDirectory($archive)|Out-Null
  $contentRoot=Join-Path $archive 'public-source-and-notices';[IO.Directory]::CreateDirectory($contentRoot)|Out-Null
  $archivedContent=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($record in $candidates){
   $copy=Join-Path $archive ($record.version+'-manifest.json')
   Copy-Item -LiteralPath $record.manifest -Destination $copy
   if((Hash $copy) -ne $record.manifestSha256){throw 'Manifest archive verification failed'}
   $original=Get-Content -LiteralPath $record.manifest -Raw -Encoding utf8|ConvertFrom-Json
   foreach($entry in $original.files){
    # Preserve historical source, metadata and legal notices, deduplicated by content.
    # Original manifests map each original path to its archived content hash.
    if($entry.path -notmatch '^(worker/src/|docs/|notices/|maintenance/|worker/package(-lock)?\.json$|worker/THIRD-PARTY-ENGINE-NOTICES\.txt$)' -and $entry.path -notmatch '(^|/)(LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*|ABOUT|ThirdPartyNotices\.txt|README[^/]*)$'){continue}
    $hash=[string]$entry.sha256
    if($hash -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid archive content hash'}
    if($archivedContent.Add($hash)){
     $content=Join-Path $contentRoot $hash.ToLowerInvariant()
     Copy-Item -LiteralPath (Join-Path $record.path $entry.path) -Destination $content
     if((Hash $content) -ne $hash){throw 'Public source archive verification failed'}
    }
   }
  }
  [ordered]@{utc=[DateTime]::UtcNow.ToString('o');current=$current;keep=$kept;remove=$candidates;archivedPublicContentCount=$archivedContent.Count;scope='Retired releases; original manifests, public source and notices retained by hash; data and media excluded'}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $archive 'plan.json') -Encoding utf8
  foreach($record in $candidates){
   if((EntryPoint) -ne $current){throw 'Entry point changed during maintenance'}
   NoProcesses
   # Revalidate the complete exact directory immediately before its only recursive operation.
   $fresh=InspectVersion $record.version
   if($fresh.path -ne $record.path -or $fresh.manifestSha256 -ne $record.manifestSha256){throw 'Removal candidate changed'}
   @{utc=[DateTime]::UtcNow.ToString('o');phase='removing';path=$record.path}|ConvertTo-Json -Compress|Add-Content -LiteralPath (Join-Path $archive 'journal.jsonl') -Encoding utf8
   Remove-Item -LiteralPath $record.path -Recurse -Force
   if(Test-Path -LiteralPath $record.path){throw 'Removal incomplete; preserve journal and inspect'}
   $removed.Add($record.version)
   @{utc=[DateTime]::UtcNow.ToString('o');phase='removed';path=$record.path}|ConvertTo-Json -Compress|Add-Content -LiteralPath (Join-Path $archive 'journal.jsonl') -Encoding utf8
  }
  foreach($record in $kept){$after=InspectVersion $record.version;if($after.manifestSha256 -ne $record.manifestSha256){throw 'Protected release changed'}}
  if((EntryPoint) -ne $current){throw 'Entry point changed'}
  NoProcesses
 }
 [pscustomobject]@{mode=if($Apply){'apply'}else{'dryrun'};current=$current;keep=$KeepVersions;remove=$RemoveVersions;removed=$removed.ToArray();archive=$archive;removedLogicalBytes=if($Apply){($candidates|Measure-Object logicalBytes -Sum).Sum}else{0};note='Logical size includes shared hardlinks; not actual freed space'}
}finally{if($lease){$lease.Dispose()}}
