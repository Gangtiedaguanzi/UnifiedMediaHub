param(
    [Parameter(Mandatory=$true)][string]$AppPath,
    [Parameter(Mandatory=$true)][string]$OutputRoot
)
$ErrorActionPreference='Stop'
$application=(Resolve-Path -LiteralPath $AppPath).Path
$evidence=[System.IO.Path]::GetFullPath($OutputRoot)
[System.IO.Directory]::CreateDirectory($evidence) | Out-Null
$data=[System.IO.Path]::Combine($evidence,'idle-data')
$observations=@()
for($iteration=1;$iteration -le 2;$iteration++){
    $process=Start-Process -FilePath $application -ArgumentList @('--data-root',('"'+$data+'"')) -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Milliseconds 1800
        $process.Refresh()
        if($process.HasExited){throw 'GUI exited before idle observation.'}
        $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" | Select-Object ProcessId,Name)
        $cpuStart=$process.TotalProcessorTime.TotalMilliseconds
        $sampleStart=[DateTimeOffset]::UtcNow
        Start-Sleep -Milliseconds 2000
        $process.Refresh()
        $record=[ordered]@{iteration=$iteration;pid=$process.Id;workingSetBytes=$process.WorkingSet64;privateBytes=$process.PrivateMemorySize64;cpuMillisecondsDuringSample=($process.TotalProcessorTime.TotalMilliseconds-$cpuStart);sampleMilliseconds=([DateTimeOffset]::UtcNow-$sampleStart).TotalMilliseconds;children=$children;tcpObservation='unavailable'}
        try {$connections=@(Get-NetTCPConnection -OwningProcess $process.Id -ErrorAction SilentlyContinue);$record.tcpObservation=$connections.Count}catch{}
        if(-not $process.CloseMainWindow()){throw 'Main window did not accept normal close.'}
        if(-not $process.WaitForExit(10000)){throw 'GUI did not exit within normal close window.'}
        $record.normalExitCode=$process.ExitCode
        $record.remainingOwnedChildren=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" | Select-Object ProcessId,Name)
        $observations+=[pscustomobject]$record
    } finally {$process.Dispose()}
}
[ordered]@{evidence='Actual self-contained GUI, master off; no platform access';application=$application;dataRoot=$data;runs=$observations} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'idle-process-observations.json') -Encoding utf8
$observations | Select-Object iteration,pid,workingSetBytes,privateBytes,cpuMillisecondsDuringSample,tcpObservation,normalExitCode
