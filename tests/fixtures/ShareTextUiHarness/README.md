# Offline share-text UI acceptance

Runs actual MainWindow.Scan_Click against a synthetic IWorkerRunner and isolated GUID SQLite fixture. No browser, network, real account, engine or automatic download. Exact input extraction is tested at the request boundary; preserving X /photo/2 does not assert asset-level selection semantics in the X engine.

Latest independent review found 3 unsupported-absolute-URI fallback regressions (javascript/file/ftp each containing an embedded platform HTTPS URL). They were reported to root; root fixed SourceClassifier. This fixture author did not edit product files.

Results:
- artifacts/x-douyin-priority/share-text-ui/independent-core.trx: initial independent 3 failed / 5 passed.
- artifacts/x-douyin-priority/share-text-ui/independent-final.trx: final 24 passed / 0 failed (16 root share cases + 8 independent cases).
- artifacts/x-douyin-priority/share-text-ui/ui-final.log: 30 WPF assertions passed; exactly3 scan requests, zero downloads/login/controls; rejected inputs create zero jobs/requests and preserve preceding preview.

Coverage: full synthetic Douyin share, X /photo/2, exact signed XHS URL, two URLs including repeated same URL, userinfo/nondefault-port/lookalike host, javascript/file/ftp absolute URI, no automatic download from selected resolved item, all synthetic operations settled.

Run from repository root:
```powershell
$env:DOTNET_CLI_HOME=Join-Path (Get-Location) '.cache/dotnet-home'
$env:NUGET_PACKAGES=Join-Path (Get-Location) '.cache/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
& .tooling/dotnet/dotnet.exe restore tests/fixtures/ShareTextUiHarness --source .cache/nuget --disable-build-servers /p:UseSharedCompilation=false
& .tooling/dotnet/dotnet.exe run --project tests/fixtures/ShareTextUiHarness --no-restore --disable-build-servers /p:UseSharedCompilation=false
```

All commands returned normally, no outstanding exec session. Cleanup is constrained to one GUID child under explicit temporary fixture base and rejects ancestor/descendant reparse points before recursive deletion.
