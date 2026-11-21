# UnifiedMediaHub — notes for AI coding agents

This file tells an AI agent (Claude Code, Codex, ChatGPT with a shell, etc.) how to install, build and change this project safely. Humans can read [docs/install.md](docs/install.md) instead.

## Installing for a user

1. Clone the repository, or use the folder the user already downloaded.
2. Run from the repository root:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -RunTests
   ```
   Add `-InstallRoot <folder>` if the user named an install location. The script downloads pinned components listed in `scripts/runtime-manifest.json`, checks every SHA-256, builds, installs and creates `统一媒体管理器.lnk` in the install root.
3. Report the shortcut path and point the user to `docs/getting-started.md`.

Rules while installing:

- Never log in, scan a QR code, or type a password, verification code or pairing token for the user. Those steps are the user's.
- Never read, copy or upload `<install root>\data`. It holds the user's accounts, browser sessions, cookies and download history.
- Do not install anything globally, register services, startup items or scheduled tasks. Everything stays inside the repository folder and the install root.
- If a download fails or a hash does not match, stop and tell the user. Do not switch to another source or skip the check.

## Repository layout

| Path | What |
|---|---|
| `src/UnifiedMediaHub.App` | WPF UI (.NET 10) |
| `src/UnifiedMediaHub.Core` | jobs, SQLite repository, source classification, worker process management |
| `tests/UnifiedMediaHub.Tests` | xUnit tests for Core and WPF |
| `worker/src`, `worker/test` | Node worker: platform adapters, downloads, browser control |
| `engines/tdl` | changes to upstream tdl v0.20.4 (AGPL-3.0) |
| `bridge/` | Douyin Tampermonkey userscript (GPL-3.0-only) |
| `scripts/` | setup, build, package, activate, verify |
| `docs/protocol.md` | the contract between Core and the worker; read it before changing either side |

## Tool locations

Use the project-local tools, never global ones:

- .NET: `.tooling\dotnet\dotnet.exe`, with `DOTNET_CLI_HOME=.cache\dotnet-home`, `NUGET_PACKAGES=.cache\nuget`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`.
- Node: `runtime\node\node.exe`; npm: `runtime\node\node.exe runtime\node\npm\package\bin\npm-cli.js`.
- Browsers: `runtime\browsers`.

## Tests

Run the Core and WPF tests first. Building them also builds `tests\fixtures\CrashHarness`, which some worker tests launch:

```powershell
.tooling\dotnet\dotnet.exe test tests\UnifiedMediaHub.Tests
```

Pass condition: zero failures.

Then the worker tests. They must preload the offline-network guard. From the repository root:

```powershell
runtime\node\node.exe --import ./worker/test/fixtures/offline-network.mjs --test --test-concurrency=2 worker/test/*.test.mjs
```

Pass condition: `# fail 0`. Keep the `--import` when running a single file.

All tests use synthetic data. Never add tests that contact a real platform, and never commit real account names, links, IDs, cookies or screenshots of real accounts.

## Making changes

- Write a test that fails for the real bug before fixing it. Do not write tests that only check UI wording or source text.
- Platform access happens only after the user turns on the master switch and starts an operation. On a captcha, rate limit or expired login, return a "needs manual action" state; never retry in a loop.
- Processes run inside the app's own Windows Job. Never kill processes by name; never reuse the user's everyday browser profile.
- Do not claim a login, scan or download works on a real platform unless you saw it work. Mark simulated results as simulated.
