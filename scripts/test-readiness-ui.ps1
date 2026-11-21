param([Parameter(Mandatory)][string]$App,[string]$OutputRoot='artifacts/readiness-ui')
$ErrorActionPreference='Stop';$project=Split-Path $PSScriptRoot
$root=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot));$artifacts=[IO.Path]::GetFullPath((Join-Path $project 'artifacts'))
if(-not $root.StartsWith($artifacts.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Test output must stay in project artifacts'}
$out=Join-Path $root ([Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($out)|Out-Null
[IO.File]::WriteAllText((Join-Path $out 'readiness-probe'),'')
$info=[Diagnostics.ProcessStartInfo]::new([IO.Path]::GetFullPath($App));$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle='Hidden'
$info.ArgumentList.Add('--smoke-test');$info.ArgumentList.Add($out)
foreach($key in @('TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$info.Environment[$key]=$out}
$gui=[Diagnostics.Process]::Start($info);$null=$gui.SafeHandle
try{
 if(-not $gui.WaitForExit(45000)){throw 'Readiness probe exceeded bound'}
 Get-Content -LiteralPath (Join-Path $out 'readiness-result.json')
 $out|Set-Content -LiteralPath (Join-Path $root 'last-run.txt') -Encoding utf8
 if($gui.ExitCode -ne 0){throw "Readiness regression failed; evidence: $out"}
}finally{if(-not $gui.HasExited){$gui.Kill();$null=$gui.WaitForExit(5000)};$gui.Dispose()}
