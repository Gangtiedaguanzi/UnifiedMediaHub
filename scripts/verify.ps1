param([Parameter(Mandatory)][string]$ReleaseRoot)
$ErrorActionPreference='Stop'
$release=[IO.Path]::GetFullPath($ReleaseRoot)
function AssertPlain([string]$p){
 $current=$p
 while($current){
  try{
   $attributes=[IO.File]::GetAttributes($current)
   if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Package reparse point rejected.'}
  }catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{
   # Missing paths are checked by the existing content validation below.
  }
  $parent=[IO.Path]::GetDirectoryName($current);if($parent -eq $current){break};$current=$parent
 }
}
AssertPlain $release
$manifestFile=Join-Path $release 'release-manifest.json'
$manifest=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.schemaVersion -ne 1 -or $manifest.entryPoint -ne 'UnifiedMediaHub.exe' -or $manifest.browserExecutable -ne 'runtime/browsers/chromium-1248/chrome-win64/chrome.exe'){throw 'Invalid package interface.'}
$expected=@{}
foreach($entry in $manifest.files){
 $relative=[string]$entry.path
 if([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or $relative.Split('/') -contains '..'){throw 'Invalid manifest path.'}
 $file=[IO.Path]::GetFullPath((Join-Path $release $relative))
 if(-not $file.StartsWith($release.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Package boundary escape.'}
 AssertPlain $file
 if($expected.ContainsKey($relative)){throw 'Duplicate manifest entry.'};$expected[$relative]=$true
 $actual=Get-Item -LiteralPath $file
 if($actual.PSIsContainer -or $actual.Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256){throw "Package content mismatch: $relative"}
}
$actualItems=@(Get-ChildItem -LiteralPath $release -Recurse -Force)
foreach($item in $actualItems){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unexpected package reparse point.'}}
$actualFiles=@($actualItems|Where-Object {-not $_.PSIsContainer})
$prefix=$release.TrimEnd('\')+'\'
foreach($file in $actualFiles){
 $full=[IO.Path]::GetFullPath($file.FullName)
 if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Package boundary escape.'}
 # Substring is safe only after the canonical directory-prefix check above;
 # unlike Path.GetRelativePath it is also available in Windows PowerShell 5.1.
 $relative=$full.Substring($prefix.Length).Replace('\','/')
 if($relative -ne 'release-manifest.json' -and -not $expected.ContainsKey($relative)){throw "Unexpected release file: $relative"}
}
if($actualFiles.Count -ne $expected.Count+1){throw 'File count mismatch.'}
foreach($required in @($manifest.entryPoint,$manifest.nodeExecutable,$manifest.workerScript,$manifest.browserExecutable,$manifest.galleryDlExecutable,$manifest.tdlExecutable)){if(-not $expected.ContainsKey($required)){throw 'Required runtime missing.'}}
if(($manifest.files|Where-Object {$_.path -match '(^|/)(private|data|\.cache|\.tooling|npm|tests|fixtures|chromium_headless_shell[^/]*)/'}).Count){throw 'Forbidden runtime content.'}
[pscustomobject]@{releaseId=$manifest.releaseId;files=$actualFiles.Count;bytes=($actualFiles|Measure-Object Length -Sum).Sum;manifestSha256=(Get-FileHash -LiteralPath $manifestFile).Hash;status='hashes-verified'}
