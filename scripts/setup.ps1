<#
.SYNOPSIS
  一键准备、构建并安装统一媒体管理器（Windows 10/11 x64，Windows PowerShell 5.1 即可）。

.DESCRIPTION
  1. 按 scripts/runtime-manifest.json 下载固定版本的 .NET SDK、Node.js、gallery-dl、修改版 tdl，
     每个文件都先核对 SHA-256，不一致就停止。
  2. 用 lock 文件安装 npm 依赖，用 Playwright 安装固定版本的 Chromium 并核对哈希。
  3. 构建程序，组装一个版本到安装目录，并创建“统一媒体管理器”快捷方式。
  所有工具都放在项目目录内（.tooling、runtime、.cache），不安装系统服务、全局依赖或启动项。
  已经准备好的部分会自动跳过，可以重复运行。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -InstallRoot D:\Apps\UnifiedMediaHub -RunTests
#>
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\UnifiedMediaHub'),
  [string]$Version = ('local-' + (Get-Date -Format 'yyyyMMdd-HHmm')),
  [switch]$PrepareOnly,
  [switch]$SkipInstall,
  [switch]$RunTests,
  [switch]$BuildTdl,
  [string]$DownloadCache
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$project = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $DownloadCache) { $DownloadCache = Join-Path $project '.cache\downloads' }
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$env:DOTNET_CLI_HOME = Join-Path $project '.cache\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $project '.cache\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:npm_config_cache = Join-Path $project '.cache\npm'
$env:npm_config_update_notifier = 'false'

function Say([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function In([string]$Relative) { Join-Path $project $Relative }
function NewDir([string]$Path) { [IO.Directory]::CreateDirectory($Path) | Out-Null; $Path }

function Fetch([string]$File, [string[]]$Urls, [string]$Sha256) {
  NewDir $DownloadCache | Out-Null
  $target = Join-Path $DownloadCache $File
  if ((Test-Path -LiteralPath $target) -and (Hash $target) -eq $Sha256) { return $target }
  foreach ($url in $Urls) {
    Say "下载 $File"
    Write-Host "    来源：$url"
    $part = "$target.part"
    try {
      Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing
    } catch {
      Write-Warning "下载失败：$($_.Exception.Message)"
      continue
    }
    $actual = Hash $part
    if ($actual -ne $Sha256) {
      Remove-Item -LiteralPath $part -Force
      throw "$File 的 SHA-256 不符（期望 $Sha256，实际 $actual）。已删除该文件并停止。"
    }
    Move-Item -LiteralPath $part -Destination $target -Force
    return $target
  }
  throw "$File 无法下载。请检查网络后重新运行；已完成的部分会跳过。"
}

function Extract([string]$Archive, [string]$Destination, [string[]]$Members = @()) {
  NewDir $Destination | Out-Null
  $arguments = @('-xf', $Archive, '-C', $Destination) + $Members
  & $tar @arguments
  if ($LASTEXITCODE -ne 0) { throw "解压失败：$Archive" }
}

function Staging() { NewDir (In ('.cache\setup-staging\' + [Guid]::NewGuid().ToString('N'))) }

function Check-Machine {
  if (-not [Environment]::Is64BitOperatingSystem) { throw '只支持 64 位 Windows。' }
  if ([Environment]::OSVersion.Version.Major -lt 10) { throw '需要 Windows 10 或 11。' }
  if (-not (Test-Path -LiteralPath $tar)) { throw "找不到系统自带的 tar.exe（$tar），需要 Windows 10 1803 或更新版本。" }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($project))
  if ($drive.AvailableFreeSpace -lt 6GB) { throw "项目所在磁盘至少需要 6 GB 可用空间（当前约 $([math]::Round($drive.AvailableFreeSpace/1GB,1)) GB）。" }
}

function Ensure-Dotnet {
  $c = $manifest.dotnetSdk
  $dotnet = In '.tooling\dotnet\dotnet.exe'
  if (Test-Path -LiteralPath $dotnet) {
    $sdks = & $dotnet --list-sdks 2>$null
    if ($sdks -match ('^' + [regex]::Escape($c.version) + ' ')) { Say ".NET SDK $($c.version) 已就绪"; return }
  }
  $zip = Fetch $c.file $c.urls $c.sha256
  Say "解压 .NET SDK $($c.version)"
  Extract $zip (In '.tooling\dotnet')
}

function Ensure-Node {
  $c = $manifest.node
  $node = In 'runtime\node\node.exe'
  $npm = In 'runtime\node\npm\package\bin\npm-cli.js'
  if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $npm) -and ((& $node --version) -eq "v$($c.version)")) { Say "Node.js $($c.version) 已就绪"; return }
  $zip = Fetch $c.file $c.urls $c.sha256
  $stage = Staging
  Say "解压 Node.js $($c.version)"
  Extract $zip $stage
  $from = Join-Path $stage $c.folder
  NewDir (In 'runtime\node\npm') | Out-Null
  Copy-Item -LiteralPath (Join-Path $from 'node.exe') -Destination $node -Force
  Copy-Item -LiteralPath (Join-Path $from 'LICENSE') -Destination (In 'runtime\node\LICENSE') -Force
  $package = In 'runtime\node\npm\package'
  if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $from 'node_modules\npm') -Destination $package
  Remove-Item -LiteralPath $stage -Recurse -Force
}

function Ensure-GalleryDl {
  $c = $manifest.galleryDl
  $engine = NewDir (In 'runtime\engines\gallery-dl')
  $notices = NewDir (In 'artifacts\third-party\gallery-dl')
  $exe = Join-Path $engine 'gallery-dl.exe'
  if (-not ((Test-Path -LiteralPath $exe) -and (Hash $exe) -eq $c.exe.sha256)) {
    Copy-Item -LiteralPath (Fetch $c.exe.file $c.exe.urls $c.exe.sha256) -Destination $exe -Force
  }
  $source = Fetch $c.source.file $c.source.urls $c.source.sha256
  $sums = Fetch $c.sums.file $c.sums.urls $c.sums.sha256
  Copy-Item -LiteralPath $source -Destination (Join-Path $notices $c.source.file) -Force
  Copy-Item -LiteralPath $sums -Destination (Join-Path $notices 'SHA256SUMS') -Force
  $sumText = Get-Content -LiteralPath $sums -Raw
  if ($sumText -notmatch $c.exe.sha256 -or $sumText -notmatch $c.source.sha256) { throw 'gallery-dl 官方 SHA256SUMS 与固定哈希不一致，停止。' }
  $license = Join-Path $engine 'LICENSE'
  if (-not ((Test-Path -LiteralPath $license) -and (Hash $license) -eq $c.source.licenseSha256)) {
    $stage = Staging
    Extract $source $stage @($c.source.licensePath)
    $extracted = Join-Path $stage $c.source.licensePath
    if ((Hash $extracted) -ne $c.source.licenseSha256) { throw 'gallery-dl 源码包里的 LICENSE 与固定哈希不一致，停止。' }
    Copy-Item -LiteralPath $extracted -Destination $license -Force
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
  $provenance = Join-Path $notices 'provenance.json'
  if (-not (Test-Path -LiteralPath $provenance)) {
    [ordered]@{ version = $c.version; release = $c.release; binarySha256 = $c.exe.sha256; sourceSha256 = $c.source.sha256; officialChecksumMatched = $true; signatureVerification = 'not performed; publisher SHA256SUMS comparison only' } |
      ConvertTo-Json | Set-Content -LiteralPath $provenance -Encoding UTF8
  }
  Say "gallery-dl $($c.version) 已就绪"
}

function Ensure-Tdl {
  $c = $manifest.tdl
  $engine = NewDir (In 'runtime\engines\tdl')
  $notices = NewDir (In 'artifacts\third-party\tdl')
  $exe = Join-Path $engine 'tdl.exe'
  $sourceZip = Join-Path $notices $c.source.file
  $haveExe = (Test-Path -LiteralPath $exe) -and (Hash $exe) -eq $c.exe.sha256
  $haveSource = (Test-Path -LiteralPath $sourceZip) -and (Hash $sourceZip) -eq $c.source.sha256
  if (-not ($haveExe -and $haveSource)) {
    if ($BuildTdl) {
      Build-Tdl
    } else {
      if (-not $c.releaseRepository) { throw '还没有配置 tdl 的发布地址（runtime-manifest.json 的 tdl.releaseRepository）。请改用 -BuildTdl 从源码构建（需要 PowerShell 7）。' }
      $base = "https://github.com/$($c.releaseRepository)/releases/download/$($c.releaseTag)"
      Copy-Item -LiteralPath (Fetch $c.exe.asset @("$base/$($c.exe.asset)") $c.exe.sha256) -Destination $exe -Force
      Copy-Item -LiteralPath (Fetch $c.source.asset @("$base/$($c.source.asset)") $c.source.sha256) -Destination $sourceZip -Force
    }
  }
  Copy-Item -LiteralPath (In 'engines\tdl\LICENSE') -Destination (Join-Path $engine 'LICENSE') -Force
  Say "tdl $($c.version) 已就绪"
}

function Build-Tdl {
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if (-not $pwsh) { throw '-BuildTdl 需要 PowerShell 7（pwsh）。' }
  $g = $manifest.go
  $go = In '.tooling\go\bin\go.exe'
  if (-not (Test-Path -LiteralPath $go)) {
    $zip = Fetch $g.file $g.urls $g.sha256
    Say "解压 Go $($g.version)"
    Extract $zip (In '.tooling')
  }
  Say '从源码构建修改版 tdl'
  & $pwsh.Source -NoProfile -File (Join-Path $PSScriptRoot 'build-tdl.ps1') -Publish
  if ($LASTEXITCODE -ne 0) { throw 'tdl 构建失败。' }
}

function Npm-Ci([string]$Folder) {
  $node = In 'runtime\node\node.exe'
  $npm = In 'runtime\node\npm\package\bin\npm-cli.js'
  Push-Location (In $Folder)
  try {
    & $node $npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败：$Folder" }
  } finally { Pop-Location }
}

function Ensure-NpmPackages {
  if (-not (Test-Path -LiteralPath (In 'worker\node_modules\playwright\package.json'))) { Say '安装 worker 依赖'; Npm-Ci 'worker' } else { Say 'worker 依赖已就绪' }
  if (-not (Test-Path -LiteralPath (In 'bridge\node_modules\jsdom\package.json'))) { Say '安装桥接脚本测试依赖'; Npm-Ci 'bridge' } else { Say '桥接测试依赖已就绪' }
}

function Ensure-Browser {
  $c = $manifest.chromium
  $chrome = In ("runtime\browsers\$($c.folder)\chrome-win64\chrome.exe")
  if (-not (Test-Path -LiteralPath $chrome)) {
    Say "安装 Chromium（Playwright $($c.playwright)）"
    $env:PLAYWRIGHT_BROWSERS_PATH = In 'runtime\browsers'
    & (In 'runtime\node\node.exe') (In 'worker\node_modules\playwright\cli.js') install --no-shell chromium
    if ($LASTEXITCODE -ne 0) { throw 'Chromium 安装失败。' }
  }
  if ((Hash $chrome) -ne $c.chromeExeSha256) { throw "Chromium 文件哈希与固定版本 $($c.chromeVersion) 不一致，停止。" }
  Say "Chromium $($c.chromeVersion) 已就绪"
  $notices = In 'artifacts\third-party\browser-notices'
  $names = @('chrome-credits.html', 'chrome-credits.txt', 'chrome-terms.html', 'chrome-terms.txt')
  $missing = @($names | Where-Object { -not (Test-Path -LiteralPath (Join-Path $notices $_)) })
  if ($missing.Count -gt 0) {
    Say '保存浏览器自带的授权说明'
    & (In 'runtime\node\node.exe') (Join-Path $PSScriptRoot 'collect-browser-notices.mjs')
    if ($LASTEXITCODE -ne 0) { throw '保存浏览器授权说明失败。' }
  }
}

function Run-Tests {
  Say '运行 worker 测试（离线）'
  Push-Location $project
  try {
    $tests = @(Get-ChildItem -LiteralPath (In 'worker\test') -Filter '*.test.mjs' | ForEach-Object { 'worker/test/' + $_.Name })
    & (In 'runtime\node\node.exe') --import ./worker/test/fixtures/offline-network.mjs --test --test-concurrency=2 @tests
    if ($LASTEXITCODE -ne 0) { throw 'worker 测试未通过。' }
    Say '运行 Core 与界面测试'
    & (In '.tooling\dotnet\dotnet.exe') test (In 'tests\UnifiedMediaHub.Tests')
    if ($LASTEXITCODE -ne 0) { throw 'Core 测试未通过。' }
  } finally { Pop-Location }
}

Check-Machine
Ensure-Dotnet
Ensure-Node
Ensure-GalleryDl
Ensure-Tdl
Ensure-NpmPackages
Ensure-Browser
if ($PrepareOnly) { Say '运行组件已准备好（-PrepareOnly，未构建）。'; return }

Say '构建程序'
& (Join-Path $PSScriptRoot 'build.ps1') | Out-Host
if ($RunTests) { Run-Tests }
if ($SkipInstall) { Say '已构建（-SkipInstall，未安装）。'; return }

Say "安装版本 $Version 到 $InstallRoot"
& (Join-Path $PSScriptRoot 'package.ps1') -Version $Version -InstallRoot $InstallRoot -Activate | Out-Host
$shortcut = Join-Path $InstallRoot '统一媒体管理器.lnk'
Say "完成。从这个快捷方式打开程序：$shortcut"
Write-Host '    账号、会话和下载历史会保存在：' (Join-Path $InstallRoot 'data')
Write-Host '    下一步请看 docs\getting-started.md（新手教程）。'
