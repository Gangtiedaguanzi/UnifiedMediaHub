param([Parameter(Mandatory)][string]$App,[string]$OutputRoot='artifacts/stage-f3b-20261110/x-login-ui',[string]$Runner='')
$ErrorActionPreference='Stop';$project=Split-Path $PSScriptRoot;$artifacts=[IO.Path]::GetFullPath((Join-Path $project 'artifacts'))+'\';$appPath=[IO.Path]::GetFullPath($App);$root=[IO.Path]::GetFullPath((Join-Path $project $OutputRoot))
if(-not $root.StartsWith($artifacts,[StringComparison]::OrdinalIgnoreCase)){throw 'Output must be isolated project artifacts'}
if($Runner){if([IO.Path]::GetFullPath($Runner) -ne (Join-Path $project '.tooling\dotnet\dotnet.exe')-or -not $appPath.StartsWith((Join-Path $project 'src\UnifiedMediaHub.App\bin\'),[StringComparison]::OrdinalIgnoreCase)-or -not $appPath.EndsWith('.dll')){throw 'Only explicit local debug DLL probe may use a runner'}}elseif(-not $appPath.StartsWith($artifacts,[StringComparison]::OrdinalIgnoreCase)){throw 'Packaged app must stay in project artifacts'}
$out=Join-Path $root ([Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($out)|Out-Null;[IO.File]::WriteAllText((Join-Path $out 'x-login-guidance-probe'),'')
$info=[Diagnostics.ProcessStartInfo]::new($(if($Runner){[IO.Path]::GetFullPath($Runner)}else{$appPath}));$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle='Hidden'
if($Runner){$info.ArgumentList.Add($appPath)};$info.ArgumentList.Add('--smoke-test');$info.ArgumentList.Add($out)
foreach($key in @('TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$info.Environment[$key]=$out}
$gui=[Diagnostics.Process]::Start($info)
try{if(-not $gui.WaitForExit(45000)){throw 'X login UI probe exceeded45seconds'};if($gui.ExitCode -ne 0){if(Test-Path (Join-Path $out 'smoke-failure.txt')){Get-Content (Join-Path $out 'smoke-failure.txt')};if(Test-Path (Join-Path $out 'startup-failure.txt')){Get-Content (Join-Path $out 'startup-failure.txt')};throw 'X login UI probe failed'};Get-Content (Join-Path $out 'x-login-guidance-result.json');$out|Set-Content (Join-Path $root 'last-run.txt') -Encoding UTF8}
finally{if(-not $gui.HasExited){$gui.Kill();$null=$gui.WaitForExit(5000)};$gui.Dispose()}
