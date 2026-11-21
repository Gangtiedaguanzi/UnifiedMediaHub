param(
 [Parameter(Mandatory)][string]$ReleaseRoot,
 [string]$OutputRoot='artifacts/task6-gui-lifecycle'
)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot
$release=[IO.Path]::GetFullPath($ReleaseRoot)
$output=if([IO.Path]::IsPathRooted($OutputRoot)){[IO.Path]::GetFullPath($OutputRoot)}else{[IO.Path]::GetFullPath((Join-Path $project $OutputRoot))}
$artifacts=[IO.Path]::GetFullPath((Join-Path $project 'artifacts'))
if($output -ne $artifacts -and -not $output.StartsWith($artifacts.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'GUI lifecycle evidence must stay inside this project artifacts directory.'}
$app=Join-Path $release 'UnifiedMediaHub.exe';$node=Join-Path $release 'runtime/node/node.exe'
$worker=Join-Path $PSScriptRoot 'fixtures/packaged-owned-worker.mjs'
foreach($file in @($app,$node,$worker)){if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'Installed fixture component missing.'}}
function Plain([string]$target){
 $current=$target
 while($current){if(Test-Path -LiteralPath $current){if((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse test path rejected.'}};$next=Split-Path $current -Parent;if($next -eq $current){break};$current=$next}
}
Plain $release;Plain $output
[IO.Directory]::CreateDirectory($output)|Out-Null
$run=Join-Path $output ('run-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($run)|Out-Null
$observations=[Collections.Generic.List[object]]::new()
$sentinelInfo=[Diagnostics.ProcessStartInfo]::new($node);$sentinelInfo.UseShellExecute=$false;$sentinelInfo.CreateNoWindow=$true;$sentinelInfo.WindowStyle='Hidden'
$sentinelInfo.ArgumentList.Add('-e');$sentinelInfo.ArgumentList.Add('setTimeout(()=>{},120000)')
$sentinel=[Diagnostics.Process]::Start($sentinelInfo)
$null=$sentinel.SafeHandle
$sentinelIdentity=@{pid=$sentinel.Id;startTimeUtc=$sentinel.StartTime.ToUniversalTime().ToString('O');path=$sentinel.MainModule.FileName}
$result=[ordered]@{evidence='Actual installed UnifiedMediaHub.exe main GUI normal-close and force-kill, synthetic owned tree/listener; no platform/account/browser';release=$release;run=$run;status='RUNNING';unrelatedSentinel=$sentinelIdentity;cases=$observations}
$resultFile=Join-Path $run 'actual-gui-lifecycle.json'
function SaveResult { $result|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $resultFile -Encoding utf8 }
try {
 SaveResult
 foreach($mode in @('normal-main-window-close','force-killed-main-gui')){
  $case=Join-Path $run $mode;[IO.Directory]::CreateDirectory($case)|Out-Null
  $treeFile=Join-Path $case 'tree.json'
  @{nodeExecutable=$node;workerScript=$worker}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $case 'x-login-worker-config.json') -Encoding utf8
  $start=[Diagnostics.ProcessStartInfo]::new($app);$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WindowStyle='Hidden';$start.WorkingDirectory=$case
  $start.ArgumentList.Add('--smoke-test');$start.ArgumentList.Add($case)
  # Child-only environment; neither current process nor user/global environment changes.
  $start.Environment['UMH_EVIDENCE']=$treeFile
  foreach($key in @('TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$start.Environment[$key]=$case}
  $gui=[Diagnostics.Process]::Start($start)
  $null=$gui.SafeHandle
  $handles=[Collections.Generic.List[Diagnostics.Process]]::new();$handles.Add($gui);$lookups=[Collections.Generic.List[Diagnostics.Process]]::new()
  $record=[ordered]@{case=$mode;isolatedSmokeRoot=$case;status='WAITING_FOR_EXPLICIT_TREE_ACK';expectedFullSmokeCompletion=$false;expectedGuiExit=if($mode -eq 'normal-main-window-close'){'0 after CloseMainWindow'}else{'nonzero after exact GUI process-handle Kill'};cleanupForcedHandles=@()}
  $observations.Add($record);SaveResult
  try {
   if($gui.Id -eq 80208){throw 'User GUI explicitly excluded.'}
   $deadline=[DateTime]::UtcNow.AddSeconds(25);$tree=$null
   while(-not $tree -and [DateTime]::UtcNow -lt $deadline){
    if($gui.HasExited){throw 'Actual GUI exited before synthetic tree readiness.'}
    if(Test-Path -LiteralPath $treeFile){try{$candidate=Get-Content -LiteralPath $treeFile -Raw|ConvertFrom-Json;if($candidate.worker -and $candidate.pid -and $candidate.grandchild.pid -and $candidate.grandchild.port){$tree=$candidate}}catch{}}
    if(-not $tree){Start-Sleep -Milliseconds 40}
   }
   if(-not $tree){throw 'No explicit child/grandchild/listener acknowledgment within bound.'}
   $record.status='TREE_ACKNOWLEDGED'
   $ids=@($gui.Id,[int]$tree.worker,[int]$tree.pid,[int]$tree.grandchild.pid)
   if(@($ids|Sort-Object -Unique).Count -ne 4 -or $ids -contains 80208 -or $ids -contains $sentinel.Id){throw 'Invalid owned identity set.'}
   $identities=@()
   for($i=0;$i -lt $ids.Count;$i++){
    $handle=if($i -eq 0){$gui}else{[Diagnostics.Process]::GetProcessById($ids[$i])}
    # GetProcessById/HasExited/StartTime alone may reopen by PID. Force a persistent
    # native process handle now, before any identity claim, and retain until Dispose.
    $nativeHandle=$handle.SafeHandle
    if($nativeHandle.IsInvalid -or $nativeHandle.IsClosed){$handle.Dispose();throw 'Persistent process handle unavailable.'}
    if($i -gt 0){$lookups.Add($handle)}
    $processInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$($ids[$i])"
    $expectedPath=if($i -eq 0){$app}else{$node}
    if($handle.HasExited -or $handle.MainModule.FileName -ne $expectedPath -or $processInfo.ExecutablePath -ne $expectedPath){throw 'Owned process executable mismatch.'}
    if($handle.StartTime.ToUniversalTime() -lt $gui.StartTime.ToUniversalTime()){throw 'Owned process predates disposable GUI.'}
    if($i -gt 0 -and $processInfo.ParentProcessId -ne $ids[$i-1]){throw 'Actual GUI/worker/child/grandchild parent chain mismatch.'}
    if($i -eq 0 -and (-not $processInfo.CommandLine.Contains('--smoke-test') -or -not $processInfo.CommandLine.Contains($case) -or $processInfo.CommandLine.Contains('--data-root'))){throw 'GUI does not belong to this isolated smoke root.'}
    if($i -gt 0){$handles.Add($handle)}
    $identities+=@{role=@('actual-main-gui','owned-worker','owned-child','owned-grandchild')[$i];pid=$handle.Id;parentPid=[int]$processInfo.ParentProcessId;startTimeUtc=$handle.StartTime.ToUniversalTime().ToString('O');path=$handle.MainModule.FileName;nativeSafeHandleRetainedBeforeVerification=$true}
   }
   $record.identities=$identities;$record.treeReadyFileLastWriteUtc=(Get-Item -LiteralPath $treeFile).LastWriteTimeUtc.ToString('O')
   $before=@(Get-NetTCPConnection -LocalPort $tree.grandchild.port -State Listen -ErrorAction SilentlyContinue|Where-Object OwningProcess -eq $tree.grandchild.pid)
   if($before.Count -ne 1 -or $before[0].LocalAddress -ne '127.0.0.1'){throw 'Acknowledged grandchild loopback listener missing.'}
   $record.listenerBefore=@{address=$before[0].LocalAddress;port=[int]$tree.grandchild.port;owningPid=[int]$before[0].OwningProcess}
   $elapsed=([DateTime]::UtcNow-(Get-Item -LiteralPath $treeFile).LastWriteTimeUtc).TotalMilliseconds
   if($elapsed -ge 8000 -or $gui.HasExited){throw 'Missed safe intervention window before smoke waiter timeout.'}
   $record.millisecondsReadyToIntervention=$elapsed;SaveResult
   $stop=[Diagnostics.Stopwatch]::StartNew()
   if($mode -eq 'normal-main-window-close'){$gui.Refresh();if(-not $gui.CloseMainWindow()){throw 'Actual main GUI did not accept CloseMainWindow.'}}
   else{$gui.Kill()}
   if(-not $gui.WaitForExit(8000)){throw 'Actual main GUI did not exit within bound.'}
   $record.actualGuiExitCode=$gui.ExitCode
   if($mode -eq 'normal-main-window-close' -and $gui.ExitCode -ne 0){throw 'Normal main-window close failed.'}
   if($mode -eq 'force-killed-main-gui' -and $gui.ExitCode -eq 0){throw 'Forced main GUI termination did not record expected nonzero exit.'}
   $deadline=[DateTime]::UtcNow.AddSeconds(7)
   do{$alive=@($handles|Where-Object {-not $_.HasExited});if($alive.Count){Start-Sleep -Milliseconds 40}}while($alive.Count -and [DateTime]::UtcNow -lt $deadline)
   $record.remainingOriginalOwnedProcesses=$alive.Count
   if($alive.Count){throw 'Original GUI-owned process survived.'}
   $after=@(Get-NetTCPConnection -LocalPort $tree.grandchild.port -State Listen -ErrorAction SilentlyContinue|Where-Object OwningProcess -eq $tree.grandchild.pid)
   $record.remainingOriginalOwnedListeners=$after.Count
   if($after.Count){throw 'Original owned listener survived.'}
   if($sentinel.HasExited){throw 'Unrelated sentinel did not survive.'}
   $record.sentinelSurvived=$true;$record.millisecondsInterventionToVerifiedExit=$stop.Elapsed.TotalMilliseconds
   $record.fullSmokePassClaimed=$false;$record.status='PASS_ACTUAL_GUI_LIFECYCLE';SaveResult
  }catch{$record.status='FAIL';$record.failure=$_.Exception.Message;SaveResult;throw}
  finally{
   # Exact retained handles only. Never by process name/saved PID; cleanup cannot earn PASS.
   foreach($handle in $handles){try{if(-not $handle.HasExited){$record.cleanupForcedHandles+=@{pid=$handle.Id;startTimeUtc=$handle.StartTime.ToUniversalTime().ToString('O')};$handle.Kill();$null=$handle.WaitForExit(5000)}}finally{$handle.Dispose()}}
   foreach($lookup in $lookups){$lookup.Dispose()}
   SaveResult
  }
 }
 $result.status='PASS_ACTUAL_MAIN_GUI_NORMAL_AND_CRASH';SaveResult
}catch{$result.status='FAIL';$result.failure=$_.Exception.Message;SaveResult;throw}
finally{try{if(-not $sentinel.HasExited){$sentinel.Kill();$null=$sentinel.WaitForExit(5000)}}finally{$sentinel.Dispose()}}
$result|ConvertTo-Json -Depth 10
