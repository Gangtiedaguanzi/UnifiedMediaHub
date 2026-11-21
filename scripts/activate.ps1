param([Parameter(Mandatory)][string]$Version,[Parameter(Mandatory)][string]$InstallRoot,[ValidateSet('none','after-shortcut')][string]$InjectFailure='none')
$ErrorActionPreference='Stop'
if($Version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'){throw 'Invalid version.'}
$install=[IO.Path]::GetFullPath($InstallRoot);$release=Join-Path (Join-Path $install 'releases') $Version
& (Join-Path $PSScriptRoot 'verify.ps1') -ReleaseRoot $release|Out-Host
$shortcut=Join-Path $install '统一媒体管理器.lnk';$pointer=Join-Path $install 'CURRENT.txt'
foreach($p in @($shortcut,$pointer)){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse publication target rejected.'}}
$stamp=[Guid]::NewGuid().ToString('N');$tempLink=Join-Path $install ($stamp+'.lnk');$tempPointer=Join-Path $install ($stamp+'.txt')
$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($tempLink);$link.TargetPath=Join-Path $release 'UnifiedMediaHub.exe';$link.Arguments='--data-root "'+(Join-Path $install 'data')+'"';$link.WorkingDirectory=$release;$link.Description='统一媒体管理器：离线预览，真实平台待验证';$link.Save()
$stream=[IO.File]::Create($tempPointer);try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($Version+"`n");$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
$oldLink=Test-Path -LiteralPath $shortcut;$oldPointer=Test-Path -LiteralPath $pointer;$linkBackup=$shortcut+'.backup-'+$stamp;$pointerBackup=$pointer+'.backup-'+$stamp;$changedLink=$false;$changedPointer=$false
try {
 if($oldLink){[IO.File]::Replace($tempLink,$shortcut,$linkBackup)}else{[IO.File]::Move($tempLink,$shortcut)};$changedLink=$true
 if($InjectFailure -eq 'after-shortcut'){throw 'Injected publication interruption.'}
 if($oldPointer){[IO.File]::Replace($tempPointer,$pointer,$pointerBackup)}else{[IO.File]::Move($tempPointer,$pointer)};$changedPointer=$true
 $read=$shell.CreateShortcut($shortcut)
 if($read.TargetPath -ne $link.TargetPath -or $read.Arguments -ne $link.Arguments -or $read.WorkingDirectory -ne $release -or (Get-Content -LiteralPath $pointer -Raw).Trim() -ne $Version){throw 'Shortcut/pointer mismatch.'}
}catch{
 if($changedPointer){if($oldPointer){[IO.File]::Copy($pointerBackup,$pointer,$true)}else{[IO.File]::Delete($pointer)}}
 if($changedLink){if($oldLink){[IO.File]::Copy($linkBackup,$shortcut,$true)}else{[IO.File]::Delete($shortcut)}}
 throw
}
Copy-Item -LiteralPath (Join-Path $release 'docs/usage.md') -Destination (Join-Path $install '使用说明.md') -Force
[pscustomobject]@{shortcut=$shortcut;target=$read.TargetPath;arguments=$read.Arguments;workingDirectory=$read.WorkingDirectory;version=$Version;dataRoot=Join-Path $install 'data'}
