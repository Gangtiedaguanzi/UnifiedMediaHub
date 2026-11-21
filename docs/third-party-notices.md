# 随附组件与对应源码

安装目录的 `notices/` 文件夹保留了各组件的授权原文；本文件不把所有组件归为同一种许可证。

|组件|版本|随附材料|
|---|---|---|
|.NET / WPF|10.0.13，自包含|发布输出的 LICENSE、ThirdPartyNotices，`notices/dotnet`、`notices/nuget`|
|Node.js|22.23.3|`runtime/node/LICENSE`|
|Playwright / playwright-core|1.64.1|包内 LICENSE、NOTICE、ThirdPartyNotices|
|Chrome for Testing|156.0.8078.4（Playwright chromium-1248）|`notices/browser`：ABOUT 以及该版本 chrome://credits、chrome://terms 的全文|
|gallery-dl|1.32.20|GPL-2.0-only 原文、官方源码包、发布者 SHA256SUMS 与来源记录（`notices/gallery-dl`）|
|tdl 修改版|v0.20.4+umh.6|AGPL-3.0、README-UMH、完整对应源码 ZIP（`notices/tdl`，内含构建方法与上游/修改记录）|
|Telegram 缩略图展开|gotd/td v0.140.0 的小型移植|`worker/THIRD-PARTY-ENGINE-NOTICES.txt` 中的 MIT 原文与 Telegram Desktop（GPL-3.0-or-later）来源说明|
|Microsoft.Data.Sqlite / SQLitePCLRaw / SQLite|10.0.13 / 2.1.13|NuGet 包内授权（`notices/nuget`）|

tdl 是明确修改过的版本，不是上游原样二进制。gallery-dl 的发布者 SHA-256 已比对，未验证分离签名。Chrome 的授权文本取自实际随附的浏览器版本，不用 Playwright 的 Apache 授权代替。

各组件的源码地址见 `notices/source-index.json`。抖音 Edge 桥接脚本在源码仓库的 `bridge/` 目录，GPL-3.0-only，不打进安装包；它的测试依赖 jsdom 只用于开发。

本项目自身以 GPL-3.0-only 发布（`engines/tdl` 为 AGPL-3.0）。以上整理不是法律意见。
