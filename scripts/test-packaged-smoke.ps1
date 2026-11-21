param([Parameter(Mandatory)][string]$App,[string]$OutputRoot='artifacts/stage-a-20261108/smoke')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot;$artifacts=[IO.Path]::GetFullPath((Join-Path $project 'artifacts'))+'\'
$appPath=[IO.Path]::GetFullPath($App);$root=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot))
if(-not $root.StartsWith($artifacts,[StringComparison]::OrdinalIgnoreCase)-or -not $appPath.StartsWith($artifacts,[StringComparison]::OrdinalIgnoreCase)){throw 'Offline smoke inputs/output must stay under project artifacts.'}
$output=Join-Path $root ([Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($output)|Out-Null
$info=[Diagnostics.ProcessStartInfo]::new($appPath);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle='Hidden'
$info.ArgumentList.Add('--smoke-test');$info.ArgumentList.Add($output)
foreach($key in @('TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$info.Environment[$key]=$output}
$gui=[Diagnostics.Process]::Start($info)
try{
 if(-not $gui.WaitForExit(45000)){throw 'Offline smoke exceeded its bound.'}
 if($gui.ExitCode -ne 0){if(Test-Path -LiteralPath (Join-Path $output 'smoke-failure.txt')){Get-Content -LiteralPath (Join-Path $output 'smoke-failure.txt')};throw "Smoke failed; isolated evidence: $output"}
 $result=Get-Content -LiteralPath (Join-Path $output 'smoke-result.json') -Raw|ConvertFrom-Json
 $output|Set-Content -LiteralPath (Join-Path $root 'last-run.txt') -Encoding utf8
 $result|ConvertTo-Json -Depth 5
}finally{if(-not $gui.HasExited){$gui.Kill();$null=$gui.WaitForExit(5000)};$gui.Dispose()}
