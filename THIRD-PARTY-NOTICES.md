# 第三方组件与许可证

本文件面向阅读源码仓库的人，说明随附组件的许可证以及它们对本项目自身许可证的影响。打包进安装目录的声明是 [docs/third-party-notices.md](docs/third-party-notices.md) 和 [worker/THIRD-PARTY-ENGINE-NOTICES.txt](worker/THIRD-PARTY-ENGINE-NOTICES.txt)，打包时还会把各组件的授权原文复制到安装目录的 `notices/`。

以下内容是工程上的整理，**不是法律意见**。

## 运行包里随附的组件

这些文件都不在 git 里（`runtime/`、`worker/node_modules/` 被忽略），由打包脚本从本地复制。

| 组件 | 版本 | 许可证 | 与本程序的关系 |
|---|---|---|---|
| .NET 运行时 / WPF | 10.0.13（自包含发布） | MIT | 程序本体运行在其上 |
| Microsoft.Data.Sqlite | 10.0.13 | MIT | NuGet 库，链接进程序 |
| SQLitePCLRaw（bundle_e_sqlite3 等） | 2.1.13 | Apache-2.0 | NuGet 库，链接进程序 |
| SQLite（e_sqlite3） | 随 SQLitePCLRaw | 公有领域 | 原生库 |
| Node.js | 22.23.3 | MIT（LICENSE 内含其依赖的各自许可） | 运行 worker 的独立进程 |
| Playwright / playwright-core | 1.64.1 | Apache-2.0 | worker 的 npm 依赖 |
| Chrome for Testing（Playwright chromium-1248） | 156.0.8078.4 | Google Chrome 服务条款 + 开源组件声明（chrome://credits） | 由 worker 启动的独立浏览器进程 |
| gallery-dl | 1.32.20 | GPL-2.0-only | 按需启动的独立可执行文件 |
| tdl（修改版） | v0.20.4+umh.6 | AGPL-3.0 | 按需启动的独立可执行文件；修改源码在 `engines/tdl/` |
| Telegram 缩略图展开（移植） | gotd/td v0.140.0 | MIT；gotd 注明其实现基于 Telegram Desktop（GPL-3.0-or-later） | 约 600 字节的头部与展开算法，移植进 `worker/src/shared/telegram-thumbnails.mjs`、`telegram-jpeg-header.mjs` |

## 只在开发时使用、不进入运行包

| 组件 | 版本 | 许可证 |
|---|---|---|
| .NET SDK | 10.0.402 | MIT 及 Microsoft .NET Library License |
| Go 工具链（构建 tdl） | 1.27.3 | BSD-3-Clause |
| xunit / xunit.runner.visualstudio | 2.9.3 / 4.0.1 | Apache-2.0 |
| Microsoft.NET.Test.Sdk | 18.11.0 | MIT |
| jsdom（bridge 测试） | 27.2.0 | MIT |
| Playwright 的 ffmpeg、headless shell | 与 1.64.1 配套 | 各自许可（在 `runtime/browsers/`，但打包脚本不复制） |

## 对本项目许可证的影响（需要注意的地方）

1. **`engines/tdl/` 必须保持 AGPL-3.0。** 这里的 overlay 和 `upstream.patch` 是对 tdl 的修改，属于 tdl 的衍生作品。分发修改版 `tdl.exe` 时必须同时提供对应源码；打包脚本已经把 `tdl-v0.20.4+umh.6-source.zip` 放进 `notices/tdl/`。AGPL 的"网络交互"条款只在把它作为网络服务提供给他人时才适用，本程序不涉及。
2. **gallery-dl（GPL-2.0-only）和 tdl（AGPL-3.0）不强制本程序采用同样的许可证。** 它们是单独的可执行文件，本程序只通过命令行参数和标准输入/输出的 JSON 与它们通信，没有链接它们的代码。通常认为这属于"聚合"。但分发时必须附上它们的许可证原文和源码获取方式（打包脚本已经这样做）。
3. **`bridge/` 已声明 GPL-3.0-only**，是独立运行在浏览器里的脚本，只通过本机 HTTP 与程序通信。
4. **Telegram 缩略图移植。** 代码直接来自 MIT 的 gotd/td，但 gotd 写明其实现基于 GPL-3.0-or-later 的 Telegram Desktop。本项目采用 GPL-3.0-only，两者没有冲突；保留 MIT 原文和 Telegram Desktop 的来源说明即可。如果将来改用 MIT 等宽松许可证，这两个文件需要单独标注 GPL-3.0-or-later，或者按公开格式说明重新实现。
5. **Chrome for Testing 不是开源许可证。** 它是 Google 的二进制，适用 Google Chrome 服务条款。源码仓库不含这个二进制，公开仓库不受影响；但如果将来公开发布**带浏览器的安装包**，需要先确认条款是否允许再分发，或者改为让使用者在安装时自行下载（`playwright install chromium`）。
6. gallery-dl 的 GPL-2.0-only 与 GPL-3.0 不能合并进同一个程序，但这里没有合并，不受影响。

## 来源

| 组件 | 来源 |
|---|---|
| Node.js | https://nodejs.org/dist/v22.23.3/ |
| Playwright | https://github.com/microsoft/playwright/tree/v1.64.1 |
| Chrome for Testing | https://cdn.playwright.dev/builds/cft/156.0.8078.4/win64/chrome-win64.zip |
| gallery-dl | https://codeberg.org/mikf/gallery-dl/releases/tag/v1.32.20 |
| tdl 上游 | https://github.com/iyear/tdl/tree/v0.20.4（提交与哈希见 `engines/tdl/upstream.json`） |
| gotd/td 缩略图 | https://github.com/gotd/td/blob/v0.140.0/telegram/thumbnail/thumbnail.go |
| .NET SDK | https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.zip |
