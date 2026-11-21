# Offline synthetic retention tests. Never executes a fixture EXE or reads real data.
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pruneScript=Join-Path $PSScriptRoot 'prune-releases.ps1'
$testRoot=[IO.Path]::GetFullPath((Join-Path $project 'artifacts/prune-releases-tests'))
$runId=[Guid]::NewGuid().ToString('N')
$temporary=[IO.Path]::GetFullPath((Join-Path $testRoot $runId))
$checks=0;$failures=[Collections.Generic.List[string]]::new();$lines=[Collections.Generic.List[string]]::new()
function PlainAncestor([string]$path){
 $at=[IO.Path]::GetFullPath($path)
 while($at){if((Test-Path -LiteralPath $at)-and ((Get-Item -LiteralPath $at -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Synthetic ancestor link rejected'};$at=[IO.Path]::GetDirectoryName($at)}
}
function Bound([string]$path){
 $full=[IO.Path]::GetFullPath($path)
 if(!$full.StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Synthetic operation escaped GUID root'}
 $full
}
function HashFile([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}
function WriteText([string]$path,[string]$value){
 $path=Bound $path;PlainAncestor $path
 [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
 [IO.File]::WriteAllText($path,$value,[Text.UTF8Encoding]::new($false))
}
function Check($condition,[string]$label){$script:checks++;if(!$condition){throw ('Check failed: '+$label)}}
function Case([string]$label,[scriptblock]$body){
 try{& $body;$message='PASS '+$label}catch{$message='FAIL '+$label+': '+$_.Exception.Message;$script:failures.Add($message)}
 $script:lines.Add($message);Write-Output $message
}
function Fixture([string]$name){
 $root=Bound (Join-Path $temporary ($name+'/install'));[IO.Directory]::CreateDirectory($root)|Out-Null
 foreach($number in 1,2,3){
  $version='0.1.0-preview.'+$number;$dir=Join-Path (Join-Path $root 'releases') $version
  $public=@{
   'UnifiedMediaHub.exe'='SYNTHETIC_NEVER_EXECUTE'
   'runtime/node/node.exe'='SYNTHETIC_SHARED_NODE'
   'runtime/browsers/chromium-1248/chrome-win64/chrome.exe'='SYNTHETIC_NEVER_EXECUTE_BROWSER'
   'runtime/engines/gallery-dl/gallery-dl.exe'='SYNTHETIC_NEVER_EXECUTE_GALLERY'
   'runtime/engines/tdl/tdl.exe'='SYNTHETIC_NEVER_EXECUTE_TDL'
   'worker/src/worker.mjs'='// SYNTHETIC public source, no platform operations'
   'docs/note.md'='SYNTHETIC public explanation'
   'docs/alias.md'='SYNTHETIC public explanation'
   'notices/example/LICENSE'='SYNTHETIC public license'
  }
  $entries=@();foreach($relative in @($public.Keys|Sort-Object)){$path=Join-Path $dir $relative;WriteText $path $public[$relative];$entries+=@{path=$relative;bytes=(Get-Item -LiteralPath $path).Length;sha256=(HashFile $path)}}
  $manifest=@{schemaVersion=1;releaseId=$version;entryPoint='UnifiedMediaHub.exe';nodeExecutable='runtime/node/node.exe';workerScript='worker/src/worker.mjs';browserExecutable='runtime/browsers/chromium-1248/chrome-win64/chrome.exe';galleryDlExecutable='runtime/engines/gallery-dl/gallery-dl.exe';tdlExecutable='runtime/engines/tdl/tdl.exe';files=$entries}
  WriteText (Join-Path $dir 'release-manifest.json') ($manifest|ConvertTo-Json -Depth 6)
 }
 WriteText (Join-Path $root 'CURRENT.txt') '0.1.0-preview.1'
 $ws=New-Object -ComObject WScript.Shell;$link=$ws.CreateShortcut((Join-Path $root '统一媒体管理器.lnk'))
 $link.TargetPath=Join-Path $root 'releases/0.1.0-preview.1/UnifiedMediaHub.exe';$link.WorkingDirectory=Join-Path $root 'releases/0.1.0-preview.1';$link.Arguments='--data-root "'+(Join-Path $root 'data')+'"';$link.Save()
 @{root=$root;old=(Join-Path $root 'releases/0.1.0-preview.3');one=(Join-Path $root 'releases/0.1.0-preview.1');two=(Join-Path $root 'releases/0.1.0-preview.2')}
}
function Prune($fixture,[switch]$Apply,[string[]]$Keep=@('0.1.0-preview.1','0.1.0-preview.2'),[string[]]$Remove=@('0.1.0-preview.3')){
 Bound $fixture.root|Out-Null;PlainAncestor $fixture.root
 & $pruneScript -InstallRoot $fixture.root -KeepVersions $Keep -RemoveVersions $Remove -Apply:$Apply
}
function Snapshot([string]$path){
 $prefix=$path.TrimEnd('\')+'\';$entries=@()
 foreach($item in Get-ChildItem -LiteralPath $path -Force -Recurse|Sort-Object FullName){
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Snapshot link rejected'}
  $relative=$item.FullName.Substring($prefix.Length)
  $entries+=if($item.PSIsContainer){'D|'+$relative}else{'F|'+$relative+'|'+$item.Length+'|'+(HashFile $item.FullName)}
 }
 $entries -join "`n"
}
function Reject($fixture,[string]$label,[scriptblock]$action){
 $before=Snapshot $fixture.root;$rejected=$false;$errorText=''
 try{& $action|Out-Null}catch{$rejected=$true;$errorText=$_.Exception.Message}
 Check $rejected $label
 $expected=@{
  'current unprotected rejected'='Current release is not protected'
  'overlap rejected'='Keep/remove overlap rejected'
  'shortcut mismatch rejected'='Shortcut and current pointer disagree'
  'extra file rejected'='Unexpected release file'
  'empty data rejected'='Unknown release directory rejected'
  'changed source rejected'='Package content mismatch'
  'file ADS rejected'='Release named stream rejected'
  'directory ADS rejected'='Release named stream rejected'
  'version escape rejected'='Unsupported release name'
  'manifest escape rejected'='Invalid manifest path'
  'lease held rejected'='Application data root is in use'
 }[$label]
 Check ($expected -and $errorText.Contains($expected)) ($label+' fails for the intended guard')
 Check ((Snapshot $fixture.root) -eq $before) ($label+' leaves fixture unchanged')
 Check (Test-Path -LiteralPath $fixture.old) ($label+' leaves removal version')
}
try{
 PlainAncestor $testRoot
 [IO.Directory]::CreateDirectory($temporary)|Out-Null
 if($PSVersionTable.PSVersion.Major -lt 7){
  Case 'unsupported PowerShell refuses before any fixture mutation' {
   $f=Fixture 'requires';$before=Snapshot $f.root;$guard=$false
   try{Prune $f -Apply|Out-Null}catch{$guard=$_.FullyQualifiedErrorId -match 'ScriptRequiresUnmatchedPSVersion' -or ($_.Exception.Message -match '#requires' -and $_.Exception.Message -match '7\.0')}
   Check $guard 'Requires PowerShell7 rejects before script body'
   Check ((Snapshot $f.root) -eq $before) 'Requires refusal does not write archive or delete release'
  }
 }else{
 Case 'dryrun is byte-for-byte and directory-list read-only' {
  $f=Fixture 'dryrun';$before=Snapshot $f.root;$r=Prune $f
  Check ($r.mode -eq 'dryrun' -and @($r.removed).Count -eq 0) 'dryrun reports no removal'
  Check ((Snapshot $f.root) -eq $before) 'dryrun creates no archive or mutation'
 }
 Case 'Apply removes only version3 and preserves shared hardlink bytes' {
  $f=Fixture 'apply';$oldNode=Bound (Join-Path $f.old 'runtime/node/node.exe');$oneNode=Join-Path $f.one 'runtime/node/node.exe'
  Remove-Item -LiteralPath $oldNode -Force
  New-Item -ItemType HardLink -Path $oldNode -Target $oneNode|Out-Null
  $oneBefore=Snapshot $f.one;$twoBefore=Snapshot $f.two;$nodeBefore=HashFile $oneNode
  $manifestBefore=HashFile (Join-Path $f.old 'release-manifest.json')
  $publicHashes=@('worker/src/worker.mjs','docs/note.md','notices/example/LICENSE'|ForEach-Object {HashFile (Join-Path $f.old $_)})
  $r=Prune $f -Apply
  Check ($r.mode -eq 'apply' -and @($r.removed).Count -eq 1 -and $r.removed[0] -eq '0.1.0-preview.3') 'exact explicit version removed'
  Check (!(Test-Path -LiteralPath $f.old)) 'version3 removed'
  Check ((Snapshot $f.one) -eq $oneBefore -and (Snapshot $f.two) -eq $twoBefore) 'both protected releases unchanged'
  Check ((HashFile $oneNode) -eq $nodeBefore) 'shared hardlink surviving content unchanged'
  $archive=[IO.Path]::GetFullPath([string]$r.archive);Check ($archive.StartsWith((Join-Path $f.root 'docs-backups')+'\',[StringComparison]::OrdinalIgnoreCase)) 'archive remains under synthetic install'
  $archived=@(Get-ChildItem -LiteralPath $archive -Recurse -File)
  $hashes=@($archived|ForEach-Object {HashFile $_.FullName})
  Check ($hashes -contains $manifestBefore) 'original manifest archive hash matches'
  foreach($hash in $publicHashes){Check ($hashes -contains $hash) 'original public source explanation notice archived by matching hash';Check (@($hashes|Where-Object {$_ -eq $hash}).Count -eq 1) 'public content deduplicated by SHA even for alias paths'}
  foreach($content in Get-ChildItem -LiteralPath (Join-Path $archive 'public-source-and-notices') -File){Check ($content.Name -match '^[a-fA-F0-9]{64}$' -and (HashFile $content.FullName) -eq $content.Name) 'archive filename and SHA match'}
  Check ((Test-Path -LiteralPath (Join-Path $archive 'plan.json')) -and (Test-Path -LiteralPath (Join-Path $archive 'journal.jsonl'))) 'plan and journal preserved'
 }
 Case 'current version cannot be removed' {
  $f=Fixture 'current';Reject $f 'current unprotected rejected' {Prune $f -Apply -Keep @('0.1.0-preview.2','0.1.0-preview.3') -Remove @('0.1.0-preview.1')}
 }
 Case 'read-only shared hardlink cannot mutate protected file attributes' {
  $f=Fixture 'readonly-shared';$oldNode=Bound (Join-Path $f.old 'runtime/node/node.exe');$oneNode=Join-Path $f.one 'runtime/node/node.exe'
  Remove-Item -LiteralPath $oldNode -Force;New-Item -ItemType HardLink -Path $oldNode -Target $oneNode|Out-Null
  $file=Get-Item -LiteralPath $oneNode;$file.Attributes=$file.Attributes -bor [IO.FileAttributes]::ReadOnly
  $before=(Get-Item -LiteralPath $oneNode).Attributes;$beforeHash=HashFile $oneNode
  $rejected=$false;try{Prune $f -Apply|Out-Null}catch{$rejected=$true}
  Check ((HashFile $oneNode) -eq $beforeHash) 'protected readonly shared bytes unchanged'
  Check ((Get-Item -LiteralPath $oneNode).Attributes -eq $before) 'protected readonly shared attributes unchanged'
  if($rejected){Check (Test-Path -LiteralPath $f.old) 'safe refusal retains candidate'}else{Check (!(Test-Path -LiteralPath $f.old)) 'successful removal completed'}
 }
 Case 'Keep and Remove overlap rejected' {
  $f=Fixture 'overlap';Reject $f 'overlap rejected' {Prune $f -Apply -Remove @('0.1.0-preview.2')}
 }
 Case 'shortcut mismatch rejected' {
  $f=Fixture 'shortcut';$ws=New-Object -ComObject WScript.Shell;$l=$ws.CreateShortcut((Join-Path $f.root '统一媒体管理器.lnk'));$l.TargetPath=Join-Path $f.two 'UnifiedMediaHub.exe';$l.Save()
  Reject $f 'shortcut mismatch rejected' {Prune $f -Apply}
 }
 Case 'unexpected ordinary file rejected' {
  $f=Fixture 'extra-file';WriteText (Join-Path $f.old 'extra.txt') 'SYNTHETIC';Reject $f 'extra file rejected' {Prune $f -Apply}
 }
 Case 'unmanifested empty data directory rejected' {
  $f=Fixture 'empty-data';[IO.Directory]::CreateDirectory((Bound (Join-Path $f.old 'data')))|Out-Null;Reject $f 'empty data rejected' {Prune $f -Apply}
 }
 Case 'manifest hash mismatch rejected' {
  $f=Fixture 'corrupt';WriteText (Join-Path $f.old 'worker/src/worker.mjs') 'SYNTHETIC_CHANGED';Reject $f 'changed source rejected' {Prune $f -Apply}
 }
 Case 'candidate file ADS rejected' {
  $f=Fixture 'file-ads';Set-Content -LiteralPath (Join-Path $f.old 'UnifiedMediaHub.exe') -Stream synthetic -Value 'SYNTHETIC'
  Reject $f 'file ADS rejected' {Prune $f -Apply}
 }
 Case 'candidate directory ADS rejected' {
  $f=Fixture 'directory-ads';[IO.File]::WriteAllText(('\\?\'+$f.old+':synthetic'),'SYNTHETIC')
  Reject $f 'directory ADS rejected' {Prune $f -Apply}
 }
 Case 'release version path escape rejected' {
  $f=Fixture 'version-escape';Reject $f 'version escape rejected' {Prune $f -Apply -Remove @('..\outside')}
 }
 Case 'manifest path escape rejected' {
  $f=Fixture 'manifest-escape';$mp=Join-Path $f.old 'release-manifest.json';$m=Get-Content -LiteralPath $mp -Raw|ConvertFrom-Json;$m.files[0].path='../outside.txt';WriteText $mp ($m|ConvertTo-Json -Depth 6)
  Reject $f 'manifest escape rejected' {Prune $f -Apply}
 }
 Case 'candidate junction rejected without touching its target' {
  $f=Fixture 'junction';$outside=Bound (Join-Path $temporary 'junction-target');WriteText (Join-Path $outside 'sentinel.txt') 'SYNTHETIC_UNTOUCHED';$link=Bound (Join-Path $f.old 'extra-junction')
  New-Item -ItemType Junction -Path $link -Target $outside|Out-Null
  try{$rejected=$false;$errorText='';try{Prune $f -Apply|Out-Null}catch{$rejected=$true;$errorText=$_.Exception.Message};Check ($rejected -and $errorText -match '[Rr]eparse') 'junction refused for reparse guard';Check (Test-Path -LiteralPath $f.old) 'junction leaves release';Check (([IO.File]::ReadAllText((Join-Path $outside 'sentinel.txt'))) -eq 'SYNTHETIC_UNTOUCHED') 'junction target untouched'}finally{
   # Delete only this explicitly created junction, never recursively follow it.
   $resolved=Bound $link;if($resolved -ne (Join-Path $f.old 'extra-junction')){throw 'Synthetic junction boundary rejected'}
   if((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($resolved,$false)}
  }
 }
 Case 'existing application data-root mutex refuses Apply' {
  $f=Fixture 'lease';$key=[Environment]::UserDomainName+'\'+[Environment]::UserName+'|'+(Join-Path $f.root 'data').ToUpperInvariant();$sha=[Security.Cryptography.SHA256]::Create()
  try{$digest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key))).Replace('-','')}finally{$sha.Dispose()}
  $created=$false;$lease=[Threading.Mutex]::new($false,('Local\UnifiedMediaHub-'+$digest),[ref]$created)
  try{Reject $f 'lease held rejected' {Prune $f -Apply}}finally{$lease.Dispose()}
 }
 }
 $result=[ordered]@{status=if($failures.Count){'failed'}else{'passed'};checks=$checks;failedCases=$failures.Count;realReleaseAccessed=$false;fixtureExecutablesStarted=0;scriptSha256=HashFile $pruneScript}
 $message=$result|ConvertTo-Json -Compress;$lines.Add($message);Write-Output $message
}finally{
 # Preserve source and this small log outside the disposable GUID directory.
 PlainAncestor $testRoot;[IO.Directory]::CreateDirectory($testRoot)|Out-Null
 [IO.File]::WriteAllLines((Join-Path $testRoot ($runId+'.log')),$lines,[Text.UTF8Encoding]::new($false))
 if(Test-Path -LiteralPath $temporary){
  $absolute=[IO.Path]::GetFullPath($temporary);$guidValue=[Guid]::Empty
  if([IO.Path]::GetDirectoryName($absolute) -ne $testRoot -or !$absolute.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)-or ![Guid]::TryParseExact([IO.Path]::GetFileName($absolute),'N',[ref]$guidValue)){throw 'Synthetic recursive delete boundary rejected'}
  PlainAncestor $absolute
  $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($absolute)
  while($stack.Count){foreach($entry in Get-ChildItem -LiteralPath ($stack.Pop()) -Force){Bound $entry.FullName|Out-Null;if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Synthetic cleanup reparse rejected'};if($entry.PSIsContainer){$stack.Push($entry.FullName)}}}
  Remove-Item -LiteralPath $absolute -Recurse -Force
 }
}
if($failures.Count){throw ('Synthetic prune failures: '+$failures.Count)}
