param([Parameter(Mandatory)][string]$App,[string]$OutputRoot='artifacts/stage-b-20261109/instance')
$ErrorActionPreference='Stop';$project=Split-Path $PSScriptRoot;$artifacts=[IO.Path]::GetFullPath((Join-Path $project 'artifacts'))+'\'
$appPath=[IO.Path]::GetFullPath($App);$root=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot))
if(-not $appPath.StartsWith($artifacts,[StringComparison]::OrdinalIgnoreCase)-or -not $root.StartsWith($artifacts,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture app/data must stay inside G project artifacts'}
$output=Join-Path $root ([Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($output)|Out-Null
$started=[Collections.Generic.List[Diagnostics.Process]]::new()
function Launch([string]$directory){
 [IO.Directory]::CreateDirectory($directory)|Out-Null;$info=[Diagnostics.ProcessStartInfo]::new($appPath);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle='Hidden'
 $info.ArgumentList.Add('--smoke-test');$info.ArgumentList.Add($directory)
 foreach($key in @('TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$info.Environment[$key]=$directory}
 $process=[Diagnostics.Process]::Start($info);$started.Add($process);return $process
}
function Exited([Diagnostics.Process]$process,[int]$limit=45000){if(-not $process.WaitForExit($limit)){throw 'Owned fixture process did not exit within its bound'};if($process.ExitCode -ne 0){throw "Owned fixture exit $($process.ExitCode)"}}
function WindowReady([Diagnostics.Process]$process){$end=[DateTime]::UtcNow.AddSeconds(10);while([DateTime]::UtcNow -lt $end){$process.Refresh();if($process.HasExited){throw 'Fixture exited before showing its primary window'};if($process.MainWindowHandle -ne [IntPtr]::Zero){return};Start-Sleep -Milliseconds 50};throw 'No owned fixture window'}
try{
 $blocked=Join-Path $output 'blocked';$data=Join-Path $blocked 'fixture-data';$private=Join-Path $data 'private';[IO.Directory]::CreateDirectory($private)|Out-Null
 $database=Join-Path $private 'hub.db';[IO.File]::WriteAllText($database,'SYNTHETIC_INVALID_DATABASE')
 $normalized=[IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($data)).ToUpperInvariant();$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($normalized))).Substring(0,16)
 $holder=[Threading.Mutex]::new($false,('Global\UnifiedMediaHub-'+$hash))
 try{$duplicate=Launch $blocked;Exited $duplicate 5000;if(Test-Path -LiteralPath (Join-Path $blocked 'startup-failure.txt')){throw 'Duplicate reached storage startup'};if([IO.File]::ReadAllText($database) -ne 'SYNTHETIC_INVALID_DATABASE'){throw 'Duplicate touched poison database'}}finally{$holder.Dispose()}
 $same=Join-Path $output 'same';$first=Launch $same;WindowReady $first;$second=Launch $same;Exited $second 5000;if($first.HasExited){throw 'Duplicate did not preserve primary process'};Exited $first
 $left=Join-Path $output 'left';$right=Join-Path $output 'right';$one=Launch $left;$two=Launch $right;WindowReady $one;WindowReady $two;Exited $one;Exited $two
 foreach($directory in @($same,$left,$right)){$result=Get-Content -LiteralPath (Join-Path $directory 'smoke-result.json') -Raw|ConvertFrom-Json;if(-not $result.status.StartsWith('PASS')){throw 'Owned fixture smoke failed'}}
 $proof=[ordered]@{blockedBeforeDatabase=$true;sameRootDuplicateExit=0;primaryPreserved=$true;differentRootWindows=2;scope='synthetic offline app instances only';status='PASS'}
 $proof|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $output 'instance-result.json') -Encoding utf8;$output|Set-Content -LiteralPath (Join-Path $root 'last-run.txt') -Encoding utf8;$proof|ConvertTo-Json
}finally{foreach($process in $started){if(-not $process.HasExited){$process.Kill();$null=$process.WaitForExit(5000)};$process.Dispose()}}
