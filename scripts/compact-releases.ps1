# Same-volume NTFS file deduplication. Existing versions and manifests stay intact.
# No writes occur without -Apply. Never edit shared release files in place.
param(
 [Parameter(Mandatory)][string]$ReleaseRoot,
 [ValidateRange(1,2147483647)][long]$MinimumBytes=1048576,
 [string]$PreferredVersion='0.1.0-preview.23',
 [string]$JournalPath,
 [string]$DataRoot,
 [switch]$Apply,
 [Parameter(DontShow)][ValidateSet('none','after-link','after-replace','after-verify')][string]$InjectFailure='none'
)
$ErrorActionPreference='Stop'
if(!('UMHCompactNative' -as [type])){Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.AccessControl;
public static class UMHCompactNative {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateHardLink(string newName,string existingName,IntPtr reserved);
 public static byte[] NormalizeAcl(byte[] bytes) {
  var descriptor=new RawSecurityDescriptor(bytes,0);
  // File.Replace may mark an ordinary file's unchanged inherited DACL as AI.
  // Preserve every other control bit, owner/group, and ordered ACL contents.
  descriptor.SetFlags(descriptor.ControlFlags & ~ControlFlags.DiscretionaryAclAutoInherited);
  var result=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(result,0);return result;
 }
}
'@}
function Full([string]$path){
 if(![IO.Path]::IsPathRooted($path)-or $path.StartsWith('\\')){throw 'Absolute local paths required'}
 $full=[IO.Path]::GetFullPath($path);if($full.Substring([IO.Path]::GetPathRoot($full).Length).Contains(':')){throw 'Alternate-stream path rejected'}
 return $(if($full -eq [IO.Path]::GetPathRoot($full)){$full}else{$full.TrimEnd('\')})
}
function Under([string]$path,[string]$root){$path.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)}
function Plain([string]$path){
 $target=Full $path;$current=$target
 while($current){
  if(Test-Path -LiteralPath $current){
   if((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse path rejected'}
   # Ancestor directory streams are not part of the ordinary file being shared.
   # Still reject every ancestor reparse, and ADS on the actual target itself.
   if($current -eq $target-and @(Get-Item -LiteralPath $current -Stream *|Where-Object {$_.Stream -ne ':$DATA'}).Count){throw 'Named stream rejected'}
  }
  $parent=[IO.Path]::GetDirectoryName($current);if($parent -eq $current){break};$current=$parent
 }
}
function Digest([byte[]]$bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Identity([string]$path){
 $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{$info=[UMHCompactNative+Info]::new();if(![UMHCompactNative]::GetFileInformationByHandle($stream.SafeFileHandle,[ref]$info)){throw 'File identity unavailable'};return [pscustomobject]@{id=('{0}:{1}:{2}' -f $info.Volume,$info.IndexHigh,$info.IndexLow);links=[int]$info.Links}}
 finally{$stream.Dispose()}
}
function Inspect([string]$path){
 Plain $path;$file=Get-Item -LiteralPath $path -Force
 if($file.PSIsContainer-or ($file.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Encrypted -bor [IO.FileAttributes]::SparseFile -bor [IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::Offline -bor [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Device))){throw 'Unsupported file attributes'}
 $security=Get-Acl -LiteralPath $path;$rawAcl=Digest ([Text.Encoding]::UTF8.GetBytes($security.Sddl));$binary=$security.GetSecurityDescriptorBinaryForm()
 $acl=Digest ([UMHCompactNative]::NormalizeAcl($binary));$control=[int]([Security.AccessControl.RawSecurityDescriptor]::new($binary,0).ControlFlags)
 $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{
  $info=[UMHCompactNative+Info]::new();if(![UMHCompactNative]::GetFileInformationByHandle($stream.SafeFileHandle,[ref]$info)){throw 'File identity unavailable'}
  $sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  return [pscustomobject]@{path=$path;hash=$hash;bytes=$stream.Length;acl=$acl;rawAcl=$rawAcl;aclControl=$control;attributes=[int]$file.Attributes;volume=$info.Volume;id=('{0}:{1}:{2}' -f $info.Volume,$info.IndexHigh,$info.IndexLow);links=[int]$info.Links}
 }finally{$stream.Dispose()}
}
function Eligible([string]$relative){
 if($relative -match '(?i)(^|/)(private|data|\.cache|cache|profiles?|user[ _-]?data|sessions?|downloads?|logs?|temp|\.tooling)(/|$)'){return $false}
 return $relative -like 'runtime/*' -or $relative -like 'worker/node_modules/*' -or $relative -like 'notices/*' -or ($relative -notmatch '/' -and $relative -like '*.dll')
}
function NoProcesses([switch]$Force) {
 if(!$Force-and $processClock.ElapsedMilliseconds-$script:lastProcessCheck -lt 1000){return}
 if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and (Under $_.ExecutablePath $ReleaseRoot)}).Count){throw 'A release process is running; stop it before compacting'}
 $script:lastProcessCheck=$processClock.ElapsedMilliseconds
}
function Journal([string]$phase,$details){
 Plain $JournalPath
 $line=@{utc=[DateTime]::UtcNow.ToString('o');phase=$phase;details=$details}|ConvertTo-Json -Depth 5 -Compress
 $stream=[IO.File]::Open($JournalPath,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes($line+[Environment]::NewLine);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
$ReleaseRoot=Full $ReleaseRoot;Plain $ReleaseRoot
if(!(Test-Path -LiteralPath $ReleaseRoot -PathType Container)){throw 'Release root missing'}
$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($ReleaseRoot));if($drive.DriveFormat -ne 'NTFS'-or $drive.DriveType -eq [IO.DriveType]::Network){throw 'Local NTFS required'}
$lease=$null;$processClock=[Diagnostics.Stopwatch]::StartNew();$lastProcessCheck=-1000
try{
if($Apply){
 if(!$DataRoot){throw 'Apply requires the application DataRoot for its existing lease'}
 $DataRoot=Full $DataRoot
 $key=[Environment]::UserDomainName+'\'+[Environment]::UserName+'|'+$DataRoot.TrimEnd('\').ToUpperInvariant()
 $name='Local\UnifiedMediaHub-'+(Digest ([Text.Encoding]::UTF8.GetBytes($key))).ToUpperInvariant();$created=$false
 $lease=[Threading.Mutex]::new($false,$name,[ref]$created)
 if(!$created){throw 'Application data root is in use'}
}
if($Apply){NoProcesses -Force}
$records=[Collections.Generic.List[object]]::new();$blocked=0;$manifestPins=@{}
foreach($version in @(Get-ChildItem -LiteralPath $ReleaseRoot -Directory -Force|Where-Object Name -Match '^0\.1\.0-preview\.\d+$')){
 Plain $version.FullName;$manifestPath=Join-Path $version.FullName 'release-manifest.json';Plain $manifestPath
 $manifestPins[$manifestPath]=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
 $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
 if($manifest.schemaVersion -ne 1 -or $manifest.releaseId -ne $version.Name){throw 'Invalid release manifest'}
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($entry in $manifest.files){
  $relative=([string]$entry.path).Replace('\','/')
  if([IO.Path]::IsPathRooted($relative)-or $relative.Contains(':')-or @($relative.Split('/')|Where-Object {$_ -in @('','.','..')}).Count-or !($seen.Add($relative))-or $entry.sha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'Invalid manifest entry'}
  $path=Full (Join-Path $version.FullName $relative);if(!(Under $path $version.FullName)){throw 'Invalid manifest entry'}
  if([long]$entry.bytes -le $MinimumBytes -or !(Eligible $relative)){continue}
  # A blocked public candidate is never followed, shared, or repaired.
  try{$file=Inspect $path}catch{$blocked++;continue}
  if(@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($path)) -Filter ([IO.Path]::GetFileName($path)+'.compact-*') -Force).Count){throw 'Pending compaction artifacts require journal recovery'}
  if($file.hash -ne $entry.sha256 -or $file.bytes -ne $entry.bytes){throw 'Candidate differs from release manifest'}
  $file|Add-Member NoteProperty relative $relative;$file|Add-Member NoteProperty version $version.Name;$records.Add($file)
 }
}
$plans=[Collections.Generic.List[object]]::new();$externalGroups=0;$saved=[long]0
foreach($group in @($records|Group-Object {$_.relative.ToLowerInvariant()+'|'+$_.hash+'|'+$_.bytes+'|'+$_.acl+'|'+$_.attributes+'|'+$_.volume})){
 $items=@($group.Group);if($items.Count -lt 2){continue};$identities=@($items|Group-Object id)
 if(@($identities|Where-Object {$_.Group[0].links -gt $_.Count}).Count){$externalGroups++;continue}
 $anchor=@($items|Sort-Object @{Expression={if($_.version -eq $PreferredVersion){0}else{1}}},@{Expression='version'})[0]
 foreach($target in $items){if($target.id -eq $anchor.id){continue};$plans.Add([pscustomobject]@{anchor=$anchor;target=$target;members=$items})}
 $saved+=[long]($identities.Count-1)*$anchor.bytes
}
$changed=0
if($Apply -and $plans.Count){
 NoProcesses -Force
 if(!$JournalPath){$JournalPath=Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) ('artifacts/compact-'+[Guid]::NewGuid().ToString('N')+'.jsonl')}
 $JournalPath=Full $JournalPath;if((Under $JournalPath $ReleaseRoot)-or $JournalPath -eq $ReleaseRoot){throw 'Journal must be outside releases'};Plain $JournalPath
 if(!(Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($JournalPath)) -PathType Container)-or (Test-Path -LiteralPath $JournalPath)){throw 'New journal with existing parent required'}
 $stream=[IO.File]::Open($JournalPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$bom=[byte[]]@(239,187,191);$stream.Write($bom,0,$bom.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 Journal 'begin' @{plannedChanges=$plans.Count;expectedContentBytes=$saved;manifestPins=$manifestPins}
 foreach($plan in $plans){
  $anchor=$plan.anchor;$target=$plan.target;$nonce=[Guid]::NewGuid().ToString('N');$temporary=$target.path+'.compact-'+$nonce+'.new';$backup=$target.path+'.compact-'+$nonce+'.bak'
  $entry=@{anchor=$anchor.path;target=$target.path;temporary=$temporary;backup=$backup;sha256=$target.hash;bytes=$target.bytes;normalizedAclHash=$target.acl;anchorRawAclHash=$anchor.rawAcl;targetRawAclHash=$target.rawAcl;attributes=$target.attributes}
  try{
   NoProcesses
   foreach($path in @($anchor.path,$target.path,$temporary,$backup)){if(!(Under (Full $path) $ReleaseRoot)){throw 'Replacement boundary rejected'};Plain $path}
   if((Test-Path -LiteralPath $temporary)-or (Test-Path -LiteralPath $backup)){throw 'Replacement path exists'}
   $a=Inspect $anchor.path;$t=Inspect $target.path
   $entry.anchorRawAclHash=$a.rawAcl;$entry.targetRawAclHash=$t.rawAcl;$entry.anchorAclControl=$a.aclControl;$entry.targetAclControl=$t.aclControl
   foreach($pair in @(@($a,$anchor),@($t,$target))){if($pair[0].hash -ne $pair[1].hash -or $pair[0].bytes -ne $pair[1].bytes -or $pair[0].acl -ne $pair[1].acl -or $pair[0].attributes -ne $pair[1].attributes -or $pair[0].volume -ne $pair[1].volume){throw 'Candidate changed since plan'}}
   if($a.id -eq $t.id){continue}
   foreach($candidate in @($a,$t)){
    $known=0;foreach($member in $plan.members){$current=Identity $member.path;if($current.id -eq $candidate.id){$known++}}
    if($candidate.links -gt $known){throw 'External hardlink appeared'}
   }
   Journal 'prepare' $entry
   if(![UMHCompactNative]::CreateHardLink($temporary,$anchor.path,[IntPtr]::Zero)){throw 'Hardlink creation failed'}
   $link=Inspect $temporary;if($link.id -ne $a.id -or $link.hash -ne $a.hash){throw 'New hardlink verification failed'}
   Journal 'linked' $entry;if($InjectFailure -eq 'after-link'){throw 'Injected after-link stop'}
   # File.Replace retains the original target as a same-directory backup.
   [IO.File]::Replace($temporary,$target.path,$backup)
   Journal 'replaced' $entry;if($InjectFailure -eq 'after-replace'){throw 'Injected after-replace stop'}
   $after=Inspect $target.path;$sourceAfter=Inspect $anchor.path;$old=Inspect $backup
   $entry.afterTargetRawAclHash=$after.rawAcl;$entry.afterAnchorRawAclHash=$sourceAfter.rawAcl;$entry.backupRawAclHash=$old.rawAcl;$entry.afterNormalizedAclHash=$after.acl;$entry.afterAclControl=$after.aclControl
   $entry.autoInheritedStateChanged=(($a.aclControl -bxor $sourceAfter.aclControl) -band 1024) -ne 0
   $checks=@{sameId=$after.id -eq $sourceAfter.id;sourceId=$after.id -eq $a.id;targetHash=$after.hash -eq $a.hash;sourceHash=$sourceAfter.hash -eq $a.hash;backupHash=$old.hash -eq $t.hash;backupId=$old.id -eq $t.id;targetAcl=$after.acl -eq $a.acl;sourceAcl=$sourceAfter.acl -eq $a.acl;backupAcl=$old.acl -eq $t.acl;targetAttributes=$after.attributes -eq $a.attributes;sourceAttributes=$sourceAfter.attributes -eq $a.attributes;backupAttributes=$old.attributes -eq $t.attributes}
   $failedChecks=@($checks.Keys|Where-Object {!$checks[$_]});if($failedChecks.Count){Journal 'verification_failed' @{entry=$entry;checks=$checks};throw ('Replacement verification failed: '+($failedChecks -join ','))}
   Journal 'verified' $entry;if($InjectFailure -eq 'after-verify'){throw 'Injected after-verify stop'}
   # Delete only this verified ordinary backup, never a release directory.
   if(!(Under (Full $backup) $ReleaseRoot)-or [IO.Path]::GetDirectoryName($backup) -ne [IO.Path]::GetDirectoryName($target.path)){throw 'Backup boundary rejected'}
   Plain $backup;[IO.File]::Delete($backup);$changed++;Journal 'committed' $entry
  }catch{Journal 'stopped_preserve_artifacts' $entry;throw}
 }
 foreach($path in $manifestPins.Keys){Plain $path;if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $manifestPins[$path]){throw 'Manifest changed'}}
 NoProcesses -Force
 Journal 'complete' @{changedFiles=$changed}
}
if($Apply){NoProcesses -Force}
[pscustomobject]@{mode=if($Apply){'apply'}else{'dryrun'};manifestCount=$manifestPins.Count;candidateFiles=$records.Count;plannedChanges=$plans.Count;changedFiles=$changed;expectedRecoverableContentBytes=$saved;blockedCandidates=$blocked;externalLinkGroups=$externalGroups;aclClasses=@($records|Group-Object acl|ForEach-Object {@{normalizedAclHash=$_.Name;rawAclHashes=@($_.Group.rawAcl|Sort-Object -Unique)}});journal=if($Apply -and $plans.Count){$JournalPath}else{$null}}
}finally{if($lease){$lease.Dispose()}}
