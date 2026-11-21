$ErrorActionPreference = 'Stop'
$TdlRoot = Split-Path $PSScriptRoot -Parent
$env:GOPATH = Join-Path $TdlRoot '.cache/go-path'
$env:GOMODCACHE = Join-Path $TdlRoot '.cache/go-mod'
$env:GOCACHE = Join-Path $TdlRoot '.cache/go-build'
$env:GOTOOLCHAIN = 'local'
$env:GOENV = 'off'
$env:CGO_ENABLED = '0'
# Go caches are project-scoped; the calling shell's home/temp and TDL_* stay intact.
# Engine smoke supplies a fresh storage and private environment to each child only.
New-Item -ItemType Directory -Force $env:GOPATH,$env:GOMODCACHE,$env:GOCACHE | Out-Null
$TdlGo = Join-Path $TdlRoot '.tooling/go/bin/go.exe'
$TdlSource = Join-Path $TdlRoot '.cache/tdl-build/tdl-0.20.4'
