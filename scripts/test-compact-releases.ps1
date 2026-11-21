$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script=Join-Path $project 'scripts/compact-releases.ps1'
$testRoot=[IO.Path]::GetFullPath((Join-Path $project 'artifacts/compact-releases-tests'))
$temporary=[IO.Path]::GetFullPath((Join-Path $testRoot ([Guid]::NewGuid().ToString('N'))))
$checks=0
function Check($condition,[string]$label){$script:checks++;if(!$condition){throw ('Check failed: '+$label)}}
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}
function Fixture([string]$name){
 $root=Join-Path $temporary $name;[IO.Directory]::CreateDirectory($root)|Out-Null
 foreach($version in @('0.1.0-preview.1','0.1.0-preview.23')){
  $dir=Join-Path $root $version;[IO.Directory]::CreateDirectory((Join-Path $dir 'runtime/node'))|Out-Null
  $entries=@();foreach($file in @('shared.dll','different.dll','acl.dll','ads.dll','external.dll','attributes.dll')){
   $bytes=[Text.Encoding]::UTF8.GetBytes(('SYNTHETIC-'+$file+'-')*30)
   if($file -eq 'different.dll' -and $version -like '*.23'){$bytes[0]=65}
   $path=Join-Path $dir ('runtime/node/'+$file);[IO.File]::WriteAllBytes($path,$bytes)
   $entries+=@{path='runtime/node/'+$file;bytes=$bytes.Length;sha256=(Hash $path)}
  }
  [IO.File]::WriteAllText((Join-Path $dir 'release-manifest.json'),(@{schemaVersion=1;releaseId=$version;files=$entries}|ConvertTo-Json -Depth 5))
  [IO.Directory]::CreateDirectory((Join-Path $dir 'private'))|Out-Null
  [IO.File]::WriteAllText((Join-Path $dir 'private/untouched.txt'),'SYNTHETIC_PRIVATE_DO_NOT_READ')
 }
 $old=Join-Path $root '0.1.0-preview.1';$new=Join-Path $root '0.1.0-preview.23'
 $aclPath=Join-Path $old 'runtime/node/acl.dll';$acl=Get-Acl -LiteralPath $aclPath
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $aclPath -AclObject $acl
 Set-Content -LiteralPath (Join-Path $old 'runtime/node/ads.dll') -Stream synthetic -Value 'SYNTHETIC_ADS'
 $attributeFile=Get-Item -LiteralPath (Join-Path $old 'runtime/node/attributes.dll');$attributeFile.Attributes=$attributeFile.Attributes -bor [IO.FileAttributes]::Hidden
 New-Item -ItemType HardLink -Path (Join-Path $root 'outside-alias.dll') -Target (Join-Path $old 'runtime/node/external.dll')|Out-Null
 return @{root=$root;old=$old;new=$new}
}
function Id([string]$file){$stream=[IO.File]::OpenRead($file);try{$info=[UMHCompactNative+Info]::new();if(![UMHCompactNative]::GetFileInformationByHandle($stream.SafeFileHandle,[ref]$info)){throw 'file identity failed'};return ('{0}:{1}:{2}' -f $info.Volume,$info.IndexHigh,$info.IndexLow)}finally{$stream.Dispose()}}
function Compact($f,[switch]$Apply,[string]$Failure='none'){
 & $script -ReleaseRoot $f.root -DataRoot (Join-Path $temporary 'synthetic-app-data') -MinimumBytes 1 -JournalPath (Join-Path $temporary ([Guid]::NewGuid().ToString('N')+'.jsonl')) -Apply:$Apply -InjectFailure $Failure
}
try{
 Check (Test-Path -LiteralPath $script) 'compact helper exists'
 $f=Fixture 'normal';$target=Join-Path $f.old 'runtime/node/shared.dll';$anchor=Join-Path $f.new 'runtime/node/shared.dll'
 [IO.File]::WriteAllText('\\?\'+$temporary+':ancestor-probe','SYNTHETIC_ANCESTOR_ADS')
 $before=Hash $target;$manifest=Hash (Join-Path $f.old 'release-manifest.json');$dry=Compact $f
 Check ($dry.changedFiles -eq 0 -and $dry.plannedChanges -eq 1) 'dryrun only one safe duplicate'
 Check ((Id $target) -ne (Id $anchor)) 'dryrun does not link'
 function AclKey([string]$sddl){$d=[Security.AccessControl.RawSecurityDescriptor]::new($sddl);$b=[byte[]]::new($d.BinaryLength);$d.GetBinaryForm($b,0);[Convert]::ToBase64String([UMHCompactNative]::NormalizeAcl($b))}
 $aclBase=AclKey 'O:SYG:SYD:(A;;FR;;;BU)'
 Check ($aclBase -eq (AclKey 'O:SYG:SYD:AI(A;;FR;;;BU)')) 'only AI state is ignored'
 foreach($different in @('O:BAG:SYD:(A;;FR;;;BU)','O:SYG:BAD:(A;;FR;;;BU)','O:SYG:SYD:P(A;;FR;;;BU)','O:SYG:SYD:AR(A;;FR;;;BU)','O:SYG:SYD:(A;;FA;;;BU)','O:SYG:SYD:(D;;FR;;;BU)')){Check ($aclBase -ne (AclKey $different)) 'owner group protection other flags ACE rights and type stay distinct'}
 Check ((AclKey 'O:SYG:SYD:(A;;FR;;;BU)(A;;FW;;;AU)') -ne (AclKey 'O:SYG:SYD:(A;;FW;;;AU)(A;;FR;;;BU)')) 'ACE order stays distinct'
 Check ($aclBase -ne (AclKey 'O:SYG:SYD:(A;OI;FR;;;BU)')) 'ACE flags stay distinct'
 $data=Join-Path $temporary 'synthetic-app-data';$key=[Environment]::UserDomainName+'\'+[Environment]::UserName+'|'+[IO.Path]::GetFullPath($data).TrimEnd('\').ToUpperInvariant();$sha=[Security.Cryptography.SHA256]::Create();try{$name='Local\UnifiedMediaHub-'+([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key)))).Replace('-','')}finally{$sha.Dispose()}
 $created=$false;$lease=[Threading.Mutex]::new($false,$name,[ref]$created);$rejected=$false;try{try{Compact $f -Apply|Out-Null}catch{$rejected=$true}}finally{$lease.Dispose()};Check $rejected 'existing application lease refuses Apply'
 Check ((Id $target) -ne (Id $anchor)) 'lease refusal did not replace a file'
 $other=@{};foreach($file in @('different.dll','acl.dll','ads.dll','external.dll','attributes.dll')){$other[$file]=Id (Join-Path $f.old ('runtime/node/'+$file))}
 $applied=Compact $f -Apply;Check ($applied.changedFiles -eq 1) 'apply one file';Check ((Id $target) -eq (Id $anchor)) 'same file identity'
 Check ([IO.File]::ReadAllText('\\?\'+$temporary+':ancestor-probe') -eq 'SYNTHETIC_ANCESTOR_ADS') 'ancestor directory ADS stays untouched while dryrun and Apply succeed'
 $verified=@(Get-Content -LiteralPath $applied.journal -Encoding UTF8|ForEach-Object {$_|ConvertFrom-Json}|Where-Object phase -eq 'verified')[0].details
 Check ($verified.anchorRawAclHash -and $verified.targetRawAclHash -and $verified.afterAnchorRawAclHash -and $verified.normalizedAclHash -eq $verified.afterNormalizedAclHash) 'raw and normalized ACL evidence retained'
 Check ((Hash $target) -eq $before -and (Hash (Join-Path $f.old 'release-manifest.json')) -eq $manifest) 'content and manifest unchanged'
 foreach($file in $other.Keys){Check ((Id (Join-Path $f.old ('runtime/node/'+$file))) -eq $other[$file]) ('excluded '+$file)}
 Check ((Get-Content -LiteralPath (Join-Path $f.old 'private/untouched.txt') -Raw) -eq 'SYNTHETIC_PRIVATE_DO_NOT_READ') 'extra subtree untouched'
 Check ((Compact $f -Apply).changedFiles -eq 0) 'idempotent rerun'
 $copy=$target+'.independent';[IO.File]::Copy($target,$copy);[IO.File]::Replace($copy,$target,$copy+'.previous')
 Check ((Id $target) -ne (Id $anchor) -and (Hash $target) -eq $before) 'independent copy restores without byte changes'
 $bad=Fixture 'invalid-manifest';$badManifest=Join-Path $bad.old 'release-manifest.json';$model=Get-Content -LiteralPath $badManifest -Raw|ConvertFrom-Json
 foreach($relative in @('runtime/../accounts.json','runtime/./node/shared.dll','runtime//node/shared.dll','runtime\..\accounts.json')){
  $model.files[0].path=$relative;[IO.File]::WriteAllText($badManifest,($model|ConvertTo-Json -Depth 5));$rejected=$false
  try{Compact $bad|Out-Null}catch{$rejected=$_.Exception.Message -eq 'Invalid manifest entry'};Check $rejected 'dot or empty manifest segment rejected before allowlist'
 }
 foreach($phase in @('after-link','after-replace','after-verify')){
  $f=Fixture $phase;$target=Join-Path $f.old 'runtime/node/shared.dll';$anchor=Join-Path $f.new 'runtime/node/shared.dll';$before=Hash $target;$rejected=$false
  try{Compact $f -Apply -Failure $phase|Out-Null}catch{$rejected=$true};Check $rejected ('injection stops '+$phase)
  $backups=@(Get-ChildItem -LiteralPath (Split-Path $target) -Filter '*.compact-*.bak' -File)
  if($phase -eq 'after-link'){Check ($backups.Count -eq 0 -and (Id $target) -ne (Id $anchor)) 'pre-replace failure preserves original'}
  else {Check ($backups.Count -eq 1 -and (Hash $backups[0].FullName) -eq $before) ('backup preserved '+$phase);[IO.File]::Replace($backups[0].FullName,$target,$target+'.rollback-previous');Check ((Hash $target) -eq $before -and (Id $target) -ne (Id $anchor)) ('rollback restored '+$phase)}
 }
 [pscustomobject]@{status='passed';checks=$checks;realReleaseAccessed=$false}|ConvertTo-Json -Compress
}finally{
 if(Test-Path -LiteralPath $temporary){
  $absolute=[IO.Path]::GetFullPath($temporary)
  if(!$absolute.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)-or [IO.Path]::GetDirectoryName($absolute) -ne $testRoot -or ![Guid]::TryParseExact([IO.Path]::GetFileName($absolute),'N',[ref]([Guid]::Empty))){throw 'Synthetic delete boundary rejected'}
  $current=$absolute;while($current){if((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Synthetic ancestor reparse rejected'};$current=[IO.Path]::GetDirectoryName($current)}
  $todo=[Collections.Generic.Stack[string]]::new();$todo.Push($absolute)
  while($todo.Count){foreach($entry in Get-ChildItem -LiteralPath ($todo.Pop()) -Force){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Synthetic reparse rejected'};if($entry.PSIsContainer){$todo.Push($entry.FullName)}}}
  Remove-Item -LiteralPath $absolute -Recurse -Force
 }
}
