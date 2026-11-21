param([Parameter(Mandatory)][string]$ReleaseRoot,[Parameter(Mandatory)][string]$OutputRoot)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot;$release=[IO.Path]::GetFullPath($ReleaseRoot);$output=[IO.Path]::GetFullPath($OutputRoot);[IO.Directory]::CreateDirectory($output)|Out-Null
$env:DOTNET_CLI_HOME=Join-Path $project '.cache/dotnet-home';$env:NUGET_PACKAGES=Join-Path $project '.cache/nuget';$env:DOTNET_CLI_TELEMETRY_OPTOUT='1';$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false';$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$sdk=Join-Path $project '.tooling/dotnet/dotnet.exe'
& $sdk build (Join-Path $project 'tests/fixtures/ReleaseLifecycle/ReleaseLifecycle.csproj') ('-p:PackageRoot='+$release) --verbosity minimal
if($LASTEXITCODE -ne 0){throw 'Packaged-core lifecycle harness build failed.'}
$harness=Join-Path $project 'tests/fixtures/ReleaseLifecycle/bin/Debug/net10.0/ReleaseLifecycle.dll'
$worker=Join-Path $PSScriptRoot 'fixtures/packaged-owned-worker.mjs'
$observations=@()
$sentinelInfo=[Diagnostics.ProcessStartInfo]::new((Join-Path $release 'runtime/node/node.exe'));$sentinelInfo.UseShellExecute=$false;$sentinelInfo.CreateNoWindow=$true;$sentinelInfo.ArgumentList.Add('-e');$sentinelInfo.ArgumentList.Add('setTimeout(()=>{},120000)');$sentinel=[Diagnostics.Process]::Start($sentinelInfo)
try {
 foreach($mode in @('normal-stop','killed-parent')){
  $case=Join-Path $output $mode;[IO.Directory]::CreateDirectory($case)|Out-Null
  $start=[Diagnostics.ProcessStartInfo]::new($sdk);$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardInput=$true
  foreach($argument in @($harness,$release,$worker,$case)){$start.ArgumentList.Add($argument)}
  $owner=[Diagnostics.Process]::Start($start)
  try {
   $ready=$owner.StandardOutput.ReadLineAsync().WaitAsync([TimeSpan]::FromSeconds(20)).GetAwaiter().GetResult();if($ready -ne 'READY'){throw 'Owned tree did not acknowledge readiness.'}
   $tree=Get-Content -LiteralPath (Join-Path $case 'tree.json') -Raw|ConvertFrom-Json
   $identities=@();foreach($processId in @($tree.worker,$tree.pid,$tree.grandchild.pid)){$p=[Diagnostics.Process]::GetProcessById($processId);$identities+=@{pid=$p.Id;startTimeUtc=$p.StartTime.ToUniversalTime().ToString('O');path=$p.MainModule.FileName};$p.Dispose()}
   $before=@(Get-NetTCPConnection -LocalPort $tree.grandchild.port -State Listen -ErrorAction SilentlyContinue)
   if($before.OwningProcess -notcontains $tree.grandchild.pid){throw 'Owned loopback listener missing.'}
   if($mode -eq 'killed-parent'){$owner.Kill()}else{$owner.StandardInput.WriteLine('');$owner.StandardInput.Flush()}
   if(-not $owner.WaitForExit(12000)){throw 'Owner did not exit.'}
   $deadline=[DateTime]::UtcNow.AddSeconds(7);$alive=@()
   do{$alive=@($identities|Where-Object{try{$p=[Diagnostics.Process]::GetProcessById($_.pid);$same=$p.StartTime.ToUniversalTime().ToString('O') -eq $_.startTimeUtc;$p.Dispose();$same}catch{$false}});if($alive.Count){Start-Sleep -Milliseconds 50}}while($alive.Count -and [DateTime]::UtcNow -lt $deadline)
   if($alive.Count){throw 'An original owned process survived.'}
   $after=@(Get-NetTCPConnection -LocalPort $tree.grandchild.port -State Listen -ErrorAction SilentlyContinue)
   if($after.OwningProcess -contains $tree.grandchild.pid){throw 'Owned listener survived.'}
   if($sentinel.HasExited){throw 'Unrelated sentinel exited.'}
   $observations+=@{case=$mode;ownerPid=$owner.Id;ownerExitCode=$owner.ExitCode;ownedIdentities=$identities;loopbackPort=$tree.grandchild.port;remainingOwned=0;remainingOwnedListeners=0;sentinelSurvived=$true}
  }finally{if(-not $owner.HasExited){$owner.Kill();$owner.WaitForExit()};$owner.Dispose()}
 }
}finally{if(-not $sentinel.HasExited){$sentinel.Kill();$sentinel.WaitForExit()};$sentinel.Dispose()}
@{evidence='Installed Core DLL and installed Node, synthetic owned child/grandchild with loopback listener. Harness parent, not GUI crash.';observations=$observations}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $output 'lifecycle.json') -Encoding utf8
$observations|Select-Object case,ownerExitCode,remainingOwned,remainingOwnedListeners,sentinelSurvived
