#Requires -Version 7.0
param(
    [switch]$Publish,
    [string[]]$TestPackages = @('./core/umh','./core/util/tutil','./app/login','./app/chat','./app/dl','./pkg/tmessage','./cmd')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tdl-env.ps1')
function AssertTdlBuildTree([string]$Path){
    $workspace=[IO.Path]::GetFullPath($TdlRoot).TrimEnd('\')
    $parent=[IO.Path]::GetFullPath((Join-Path $workspace '.cache/tdl-build'))
    $resolved=[IO.Path]::GetFullPath($Path)
    if($resolved -ne (Join-Path $parent 'tdl-0.20.4') -or [IO.Path]::GetDirectoryName($resolved) -ne $parent -or !$resolved.StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected build cleanup target'}
    $current=$resolved
    while($current){
        try{if([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint){throw 'Build ancestor reparse rejected'}}catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{}
        $current=[IO.Path]::GetDirectoryName($current)
    }
    if([IO.Directory]::Exists($resolved)){
        $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($resolved)
        while($pending.Count){foreach($entry in Get-ChildItem -LiteralPath ($pending.Pop()) -Force){
            $full=[IO.Path]::GetFullPath($entry.FullName)
            if(!$full.StartsWith($resolved+'\',[StringComparison]::OrdinalIgnoreCase) -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Build descendant reparse or escape rejected'}
            if($entry.PSIsContainer){$pending.Push($full)}
        }}
    }
    $resolved
}
# Only this child receives a private home/temp and cleared inherited TDL_*.
# Raw output is bounded and held in memory; a failed smoke prints no diagnostics.
function InvokeTdlSmoke([string[]]$Arguments){
    $smokeHome=Join-Path $smoke ([Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($smokeHome)|Out-Null
    $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$exe
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$smokeHome
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.RedirectStandardInput=$true
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    foreach($key in @($start.Environment.Keys)){if($key -like 'TDL_*'){$null=$start.Environment.Remove($key)}}
    foreach($key in @('HOME','USERPROFILE','TEMP','TMP','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME')){$start.Environment[$key]=$smokeHome}
    foreach($arg in @('--storage',('type=bolt,path='+(Join-Path $smokeHome 'storage')),'-n','umh-offline-smoke')+@($Arguments)){$start.ArgumentList.Add($arg)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start;$started=$false
    try{
        $started=$process.Start();$process.StandardInput.Close()
        $outBuffer=[char[]]::new(4096);$errBuffer=[char[]]::new(4096)
        $stdout=[Text.StringBuilder]::new();$stderr=[Text.StringBuilder]::new()
        $outRead=$process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length);$errRead=$process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)
        $clock=[Diagnostics.Stopwatch]::StartNew();$characters=0
        while($outRead -or $errRead -or !$process.HasExited){
            if($clock.ElapsedMilliseconds -ge 15000){throw 'Engine smoke timeout'}
            if($outRead -and $outRead.IsCompleted){$n=$outRead.GetAwaiter().GetResult();if($n){$characters+=$n;if($characters -gt 262144){throw 'Engine smoke output limit'};$null=$stdout.Append($outBuffer,0,$n);$outRead=$process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)}else{$outRead=$null}}
            if($errRead -and $errRead.IsCompleted){$n=$errRead.GetAwaiter().GetResult();if($n){$characters+=$n;if($characters -gt 262144){throw 'Engine smoke output limit'};$null=$stderr.Append($errBuffer,0,$n);$errRead=$process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)}else{$errRead=$null}}
            if(!$process.HasExited){$null=$process.WaitForExit(10)}elseif($outRead -or $errRead){[Threading.Thread]::Sleep(1)}
        }
        [pscustomobject]@{exitCode=$process.ExitCode;stdout=$stdout.ToString();stderr=$stderr.ToString();home=$smokeHome}
    }finally{
        if($started -and !$process.HasExited){$process.Kill($true);$null=$process.WaitForExit(3000)}
        $process.Dispose()
    }
}
$meta = Get-Content (Join-Path $TdlRoot 'engines/tdl/upstream.json') -Raw | ConvertFrom-Json
if ((Get-FileHash $TdlGo).Hash -ne $meta.goExeSha256) { throw 'Portable Go executable hash mismatch' }
if ((& $TdlGo version) -ne "go version $($meta.goVersion) windows/amd64") { throw 'Unexpected Go toolchain' }
$archive = Join-Path $TdlRoot '.cache/tdl-v0.20.4.zip'
if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest $meta.archiveUrl -OutFile $archive }
if ((Get-FileHash $archive).Hash -ne $meta.archiveSha256) { throw 'Upstream archive hash mismatch' }
$buildParent = [IO.Path]::GetFullPath((Join-Path $TdlRoot '.cache/tdl-build'))
$resolvedSource = AssertTdlBuildTree $TdlSource
if (Test-Path -LiteralPath $resolvedSource) { Remove-Item -LiteralPath $resolvedSource -Recurse -Force }
Expand-Archive -LiteralPath $archive -DestinationPath $buildParent
$pins = @('go.mod','go.sum','go.work','go.work.sum','core/go.mod','core/go.sum','extension/go.mod','extension/go.sum')
$before = @{}; foreach ($pin in $pins) { $before[$pin] = (Get-FileHash (Join-Path $TdlSource $pin)).Hash }
$overlayRoot = [IO.Path]::GetFullPath((Join-Path $TdlRoot 'engines/tdl/overlay'))
$overlayManifest = Get-Content (Join-Path $TdlRoot 'engines/tdl/overlay-manifest.json') -Raw | ConvertFrom-Json
if (@(Get-ChildItem -LiteralPath $overlayRoot -Recurse -File).Count -ne $overlayManifest.Count) { throw 'Unrecorded overlay file' }
foreach ($entry in $overlayManifest) {
    $entryPath = [IO.Path]::GetFullPath((Join-Path $overlayRoot $entry.Path))
    if (!$entryPath.StartsWith($overlayRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash $entryPath).Hash -ne $entry.Sha256) { throw 'Overlay integrity mismatch' }
}
Copy-Item (Join-Path $TdlRoot 'engines/tdl/overlay/*') $TdlSource -Recurse -Force
$out = Join-Path $TdlRoot 'artifacts/third-party/tdl'
New-Item -ItemType Directory -Force $out | Out-Null
Push-Location $TdlSource
try {
    & $TdlGo mod download
    if ($LASTEXITCODE) { throw 'Pinned module download failed' }
    & $TdlGo mod verify
    if ($LASTEXITCODE) { throw 'Module checksum verification failed' }
    & $TdlGo test -count=1 @TestPackages
    if ($LASTEXITCODE) { throw 'Focused offline tests failed' }
    & $TdlGo build -trimpath -ldflags '-s -w -X github.com/iyear/tdl/pkg/consts.Version=v0.20.4+umh.6 -X github.com/iyear/tdl/pkg/consts.Commit=9d7d49e+umh.6 -X github.com/iyear/tdl/pkg/consts.CommitDate=2026-11-16' -o (Join-Path $out 'tdl.exe') .
    if ($LASTEXITCODE) { throw 'Windows build failed' }
} finally { Pop-Location }
foreach ($pin in $pins) { if ((Get-FileHash (Join-Path $TdlSource $pin)).Hash -ne $before[$pin]) { throw "Pinned module file changed: $pin" } }
# Each binary smoke starts with a fresh, private home and temp directory.
$smoke = Join-Path $TdlRoot ('.cache/tdl-smoke-' + [guid]::NewGuid().ToString('N'))
$exe = Join-Path $out 'tdl.exe'
$versionSmoke=InvokeTdlSmoke @('version')
if($versionSmoke.exitCode -ne 0 -or ($versionSmoke.stdout+$versionSmoke.stderr) -notmatch 'v?0\.20\.4\+umh\.5'){throw 'Version smoke failed'}
foreach ($sub in @(@('umh','login','--help'),@('umh','login-qr','--help'),@('umh','identity','--help'),@('umh','chats','--help'),@('download','--help'),@('chat','export','--help'))) {
    $helpSmoke=InvokeTdlSmoke $sub
    if ($helpSmoke.exitCode -ne 0) { throw 'Help smoke failed' }
}
# Invalid command arguments fail before any platform request and must not echo diagnostics.
foreach($case in @(
    @{arguments=@('umh','identity','--invalid=synthetic-secret');code='operation_failed'},
    @{arguments=@('umh','chats','--limit','0');code='invalid_input'},
    @{arguments=@('umh','chats','--limit','5001');code='invalid_input'},
    @{arguments=@('umh','chats','--limit','-1');code='invalid_input'},
    @{arguments=@('umh','chats','--limit','synthetic-secret');code='operation_failed'},
    @{arguments=@('umh','chats','--invalid=synthetic-secret');code='operation_failed'}
)){
    $failure=InvokeTdlSmoke $case.arguments
    if($failure.exitCode -eq 0 -or $failure.stderr.Trim() -or $failure.stdout.Contains('synthetic-secret')){throw 'Machine diagnostic smoke failed'}
    try{$event=$failure.stdout|ConvertFrom-Json -ErrorAction Stop}catch{throw 'Machine error was not JSON'}
    if(@($event).Count -ne 1 -or $event.type -ne 'error' -or $event.version -ne 1 -or $event.code -ne $case.code -or (($event.PSObject.Properties.Name|Sort-Object) -join ',') -ne 'code,type,version'){throw 'Machine diagnostic schema failed'}
}
Copy-Item (Join-Path $TdlRoot 'engines/tdl/README.md') (Join-Path $TdlSource 'BUILD-UMH.md')
Copy-Item (Join-Path $TdlRoot 'engines/tdl/upstream.json') (Join-Path $TdlSource 'UMH-UPSTREAM.json')
Copy-Item (Join-Path $TdlRoot 'engines/tdl/overlay-manifest.json') (Join-Path $TdlSource 'UMH-OVERLAY.json')
Compress-Archive -Path $TdlSource -DestinationPath (Join-Path $out 'tdl-v0.20.4+umh.6-source.zip') -Force
Copy-Item $archive (Join-Path $out 'tdl-v0.20.4-upstream.zip') -Force
Copy-Item (Join-Path $TdlSource 'LICENSE') (Join-Path $out 'LICENSE') -Force
Copy-Item (Join-Path $TdlRoot 'engines/tdl/README.md') (Join-Path $out 'README.md') -Force
$hashes = Get-ChildItem -LiteralPath $out -File | Where-Object Name -ne 'sha256.json' | ForEach-Object { [ordered]@{Name=$_.Name;Sha256=(Get-FileHash $_.FullName).Hash;Bytes=$_.Length} }
$hashes | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $out 'sha256.json')
if ($Publish) {
    $runtime = Join-Path $TdlRoot 'runtime/engines/tdl/tdl.exe'
    if (Test-Path -LiteralPath $runtime) {
        $oldHash = (Get-FileHash $runtime).Hash
        $backup = Join-Path $TdlRoot ('.cache/tdl-backup-' + $oldHash + '.exe')
        if (!(Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $runtime -Destination $backup }
        if ((Get-FileHash $backup).Hash -ne $oldHash) { throw 'Runtime backup mismatch' }
    }
    New-Item -ItemType Directory -Force (Split-Path $runtime) | Out-Null
    Copy-Item -LiteralPath $exe -Destination $runtime -Force
    if ((Get-FileHash $runtime).Hash -ne (Get-FileHash $exe).Hash) { throw 'Published binary mismatch' }
}
Write-Output "Verified build and complete source bundle: $out"
