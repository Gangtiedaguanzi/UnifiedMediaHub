# 统一媒体管理器（UnifiedMediaHub）

> **English summary.** UnifiedMediaHub is a Windows desktop app (WPF, .NET 10) with a Node.js worker. It lets you scan and download media from *your own* lists on X, Douyin, Xiaohongshu and Telegram (likes, saved items, folders, chats you can already see), using your own logins. Everything runs locally: accounts and history stay on your computer, and nothing is sent to the author or any third party. One script (`scripts/setup.ps1`) fetches pinned, hash-checked components, builds and installs the app; see [docs/install.md](docs/install.md). The UI is Chinese only. License: GPL-3.0-only, except `engines/tdl/` (AGPL-3.0, modified upstream tdl).

## 它做什么

- 在一个窗口里管理 X、抖音、小红书、Telegram 四个平台上**你自己账号能看到**的内容：单条作品、作者作品、我的喜欢、我的收藏和收藏夹、Telegram 频道/群/话题。
- 先扫描出清单，你勾选后再下载；保留历史、去重，缺失的文件可以补下。
- 每次下载默认放进一个任务文件夹（`分类/平台/来源_名字_时间/`），文件平铺在里面，按名称排序就是按时间排序。
- 登录只由你本人在程序打开的登录窗口里完成；验证码、限流、登录失效会停下来交给你处理，不会自动重试。
- 抖音的列表通过一个 Edge 用户脚本（[bridge/](bridge/README.md)）从你自己的浏览器发送到程序。

各平台哪些已经实测、哪些还没有，见 [能力与限制](docs/capabilities.md)。

## 快速开始

1. 取得源码：`git clone`，或在 GitHub 页面点 Code → Download ZIP。
2. 在项目文件夹里运行：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
   ```
3. 从安装目录的 `统一媒体管理器.lnk` 打开，按 [新手教程](docs/getting-started.md) 登录和下载。

也可以让能执行命令的 AI 助手（Claude Code、ChatGPT 等）代为安装，提示词见 [安装 → 让 AI 助手代为安装](docs/install.md#让-ai-助手代为安装)。

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | 安装、更新、卸载、下载了哪些组件 |
| [docs/getting-started.md](docs/getting-started.md) | 新手教程，包括抖音 Edge 桥接配置 |
| [docs/usage.md](docs/usage.md) | 各功能说明 |
| [docs/capabilities.md](docs/capabilities.md) | 能力与限制 |
| [docs/protocol.md](docs/protocol.md) | Core 与 worker 之间的协议（开发用） |
| [AGENTS.md](AGENTS.md) | 给 AI 代理的安装与开发规则 |

## 支持的环境

| 项目 | 说明 |
|---|---|
| 操作系统 | Windows 10（1803 或更新）/ 11，64 位 |
| 内容平台 | X、抖音、小红书、Telegram |
| 界面语言 | 中文 |
| 抖音列表 | 需要 Microsoft Edge + Tampermonkey |

## 隐私

- 账号、登录会话、Cookie、配对令牌和下载历史只保存在你的安装目录 `data\private`，只有当前 Windows 用户能访问。
- 程序只连接你使用的平台和本机地址，没有统计、遥测或自动更新，不会把任何数据发给作者或第三方。
- 反馈问题时请只附“设置 → 维护 → 导出诊断报告”生成的脱敏报告。

## 开发

### 目录结构

| 路径 | 内容 |
|---|---|
| `src/UnifiedMediaHub.App` | WPF 界面 |
| `src/UnifiedMediaHub.Core` | 任务、数据库、来源识别、worker 进程管理 |
| `tests/UnifiedMediaHub.Tests` | xUnit 测试（Core 与 WPF 界面） |
| `worker/src`、`worker/test` | Node worker（各平台适配、下载、浏览器控制）及其测试 |
| `engines/tdl` | 对上游 tdl v0.20.4 的修改（overlay + patch），AGPL-3.0 |
| `bridge/` | 抖音 Edge 桥接用户脚本，GPL-3.0-only |
| `scripts/` | 安装、构建、打包、启用、校验脚本 |

### 准备与构建

```powershell
# 只准备运行组件（.tooling、runtime、node_modules），不构建不安装
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -PrepareOnly

# 每个新的 PowerShell 窗口先设置项目内缓存
$env:DOTNET_CLI_HOME = "$PWD\.cache\dotnet-home"
$env:NUGET_PACKAGES  = "$PWD\.cache\nuget"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'

# 自包含发布到 artifacts\current-app
.\scripts\build.ps1

# 组装一个版本到 <安装目录>\releases\<版本号>（不覆盖已有版本），并切换快捷方式
.\scripts\package.ps1 -Version <版本号> -InstallRoot <安装目录> -Activate
```

修改版 tdl 可以用 `scripts\build-tdl.ps1`（PowerShell 7 + Go）从源码重新构建。

### 测试

先跑 Core 与界面测试。它会顺带构建 worker 测试要启动的辅助程序 `tests\fixtures\CrashHarness`：

```powershell
.tooling\dotnet\dotnet.exe test tests\UnifiedMediaHub.Tests
```

通过标准是失败数为 0。

再跑 worker 测试。必须预加载断网保护，在仓库根目录运行：

```powershell
runtime\node\node.exe --import ./worker/test/fixtures/offline-network.mjs --test --test-concurrency=2 worker/test/*.test.mjs
```

通过标准是输出末尾 `# fail 0`。所有测试都是离线的合成数据，不访问真实平台、不读取任何账号。

## 使用者责任与平台条款

- 本程序只用于下载**你自己有权访问、并有权保存**的内容，例如你自己的收藏和喜欢。下载、保存或再分发他人作品，可能需要作者授权。
- 使用前请阅读并遵守各平台的用户协议与开发者条款（X、抖音、小红书、Telegram）。部分平台不允许自动化访问或批量下载；是否使用、如何使用，由使用者自行判断并承担责任。
- 程序不绕过验证码、不破解加密、不共享账号；遇到平台限制会停下来交给你。
- 平台网页经常变化，功能可能随时失效。
- 本项目与上述平台没有任何关联，也没有得到它们的认可。

## 许可证

本项目以 **GPL-3.0-only** 发布，全文见 [LICENSE](LICENSE)。例外：

- `engines/tdl/`：对上游 tdl 的修改，按上游要求使用 AGPL-3.0（见 `engines/tdl/LICENSE`）。
- `bridge/`：GPL-3.0-only（见 `bridge/COPYING`），与项目一致。

随附第三方组件及其许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
