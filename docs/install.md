# 安装

## 需要什么

- Windows 10（1803 或更新）或 Windows 11，64 位。
- 项目所在磁盘至少 6 GB 可用空间（运行组件约 2 GB，构建缓存另计）。
- 能访问 nodejs.org、microsoft.com、codeberg.org、github.com、npm 和 Playwright 下载站的网络。
- 要用抖音功能的话，还需要 Microsoft Edge 和 Tampermonkey 扩展。

## 第一步：取得源码

任选一种：

- 有 git：
  ```powershell
  git clone https://github.com/Gangtiedaguanzi/UnifiedMediaHub.git
  cd UnifiedMediaHub
  ```
- 没有 git：在 GitHub 页面点 **Code → Download ZIP**，解压到任意文件夹（例如 `D:\src\UnifiedMediaHub`），再在这个文件夹里打开 PowerShell。

## 第二步：运行一键安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
```

它会依次：

1. 下载固定版本的运行组件（见下表），每个文件都先核对 SHA-256，不一致就停止。
2. 用 lock 文件安装 npm 依赖，用 Playwright 安装固定版本的 Chromium。
3. 构建程序，装到安装目录，并创建快捷方式 `统一媒体管理器.lnk`。

第一次运行需要下载约 700 MB，一般 10～30 分钟。中途失败可以直接重新运行，已完成的部分会跳过。

`-ExecutionPolicy Bypass` 只对这一次命令有效，不改系统设置。

### 常用参数

| 参数 | 作用 |
|---|---|
| `-InstallRoot <文件夹>` | 安装位置。默认 `%LOCALAPPDATA%\Programs\UnifiedMediaHub` |
| `-RunTests` | 构建后先跑全部离线测试 |
| `-PrepareOnly` | 只准备运行组件，不构建、不安装 |
| `-SkipInstall` | 准备并构建，但不安装 |
| `-BuildTdl` | 不下载预编译的 tdl，用 Go 从源码构建（需要 PowerShell 7） |

### 下载了什么

固定版本和哈希写在 [scripts/runtime-manifest.json](../scripts/runtime-manifest.json)。

| 组件 | 来源 | 放到 |
|---|---|---|
| .NET SDK 10.0.402（只用于构建） | builds.dotnet.microsoft.com | `.tooling\dotnet` |
| Node.js 22.23.3 | nodejs.org | `runtime\node` |
| gallery-dl 1.32.20 及其源码包 | codeberg.org/mikf/gallery-dl | `runtime\engines\gallery-dl` |
| 修改版 tdl v0.20.4+umh.6 及其源码包 | 本仓库的 GitHub Release（源码在 `engines/tdl`） | `runtime\engines\tdl` |
| npm 依赖（playwright 1.64.1；测试用 jsdom） | npm 官方源，按 lock 文件 | `worker\node_modules`、`bridge\node_modules` |
| Chrome for Testing 156.0.8078.4 | Playwright 官方下载站 | `runtime\browsers` |
| NuGet 包 | nuget.org | `.cache\nuget` |

所有东西都放在项目文件夹里，不装系统服务、全局依赖、启动项或计划任务。

## 第三步：打开程序

从安装目录里的 `统一媒体管理器.lnk` 打开（可以自己复制一份到桌面）。接下来按 [新手教程](getting-started.md) 登录和下载。

## 让 AI 助手代为安装

可以让 Claude Code、ChatGPT 等能在你电脑上执行命令的 AI 助手代为安装。把下面这段话发给它：

> 请在我的 Windows 电脑上安装 https://github.com/Gangtiedaguanzi/UnifiedMediaHub 。先阅读仓库里的 AGENTS.md 和 docs/install.md，然后克隆仓库并运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -RunTests`。不要替我登录任何账号，不要读取安装目录下的 data 文件夹。完成后告诉我快捷方式在哪里。

登录、扫码和输入密码都要你自己来做。

## 更新

```powershell
git pull
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -InstallRoot <原来的安装目录>
```

新版本装在 `<安装目录>\releases\<新版本号>`，快捷方式会切到新版本；`data` 文件夹（账号和历史）保持不变。回退方法见 [使用说明](usage.md#更新与回退)。

## 卸载

1. 关闭程序。
2. 删除安装目录。**注意：其中的 `data` 文件夹保存了你的账号登录和下载历史，删除后无法恢复。**
3. 删除项目文件夹（源码和运行组件）。

下载的媒体文件在你设置的下载位置，不会被删除。

## 常见问题

| 现象 | 处理 |
|---|---|
| 某个文件下载失败 | 检查网络后重新运行；已下载的会跳过 |
| 提示 SHA-256 不符 | 文件被篡改或下载不完整，脚本已删除它。重新运行；仍然不符请到 GitHub 反馈 |
| 杀毒软件拦截 gallery-dl.exe 或 tdl.exe | 两者都是开源下载工具，哈希与官方发布一致。是否放行由你决定 |
| 提示找不到 tar.exe | Windows 版本太旧，需要 Windows 10 1803 或更新 |
| 提示没有配置 tdl 发布地址 | 加 `-BuildTdl` 从源码构建（需要 PowerShell 7） |
