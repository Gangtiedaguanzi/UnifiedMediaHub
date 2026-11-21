param([string]$Output='artifacts/current-app')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot
$env:DOTNET_CLI_HOME=Join-Path $project '.cache/dotnet-home'
$env:NUGET_PACKAGES=Join-Path $project '.cache/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$destination=[IO.Path]::GetFullPath((Join-Path $project $Output))
& (Join-Path $project '.tooling/dotnet/dotnet.exe') publish (Join-Path $project 'src/UnifiedMediaHub.App/UnifiedMediaHub.App.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false --disable-build-servers /p:UseSharedCompilation=false -o $destination --verbosity minimal
if($LASTEXITCODE -ne 0){throw 'Self-contained publish failed.'}
$files=@(Get-ChildItem -LiteralPath $destination -File -Recurse)
[ordered]@{path=$destination;files=$files.Count;bytes=($files|Measure-Object Length -Sum).Sum}|ConvertTo-Json
