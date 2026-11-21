# 抖音 Edge 桥接脚本

`umh-douyin-bridge.user.js` 是一个 Tampermonkey 用户脚本。它在你自己的 Edge 里读取抖音页面上已经显示的作品列表（我的喜欢、收藏、单个收藏夹、作者作品），经本机 HTTP 发送给统一媒体管理器。许可证 GPL-3.0-only，全文见 [COPYING](COPYING)。

安装和使用步骤见 [新手教程](../docs/getting-started.md#4-抖音-edge-桥接)。

## 它做什么，不做什么

- 只在你点击“读取当前页”“继续加载”“发送”时工作；不自动滚动、不自动发送。
- 只读取页面上可见列表里的作品数据；不调用抖音接口、不读取 Cookie、不读取账号信息（清单里显示“身份未提供”）。
- 只连接 `localhost`，不加载任何远程代码。
- 每次读取默认 20 条，最多 1000 条、50 轮，每轮间隔 1.2 秒；连续 3 轮没有新内容或到底就停止。单个作品先裁剪到必要字段再限制 256 KiB，一批最多 8 MiB。超过的作品会标记为“过大”并提示，不会被后面的作品顶替。

## 安全说明

- 配对令牌保存在 Tampermonkey 的脚本存储里，只在点击“发送”时读取。
- Tampermonkey 使用 `raw` 模式时，脚本和抖音页面在同一个 JavaScript 环境里，令牌对页面里的其他脚本**不是保密的**。程序端因此另外做了这些限制：只监听 127.0.0.1、拒绝带 `Origin` 的网页请求、校验大小和格式、只接受白名单内的 CDN 地址、下载必须由你在程序里手动勾选。完整的威胁模型和对应测试见 [docs/protocol.md](../docs/protocol.md)。
- 怀疑令牌泄露时，在程序“设置 → 抖音 Edge 桥接”点“重新生成”。

## 开发与测试

测试用 jsdom 27.2.0，依赖只装在本目录的 `node_modules`，不进入安装包：

```powershell
cd bridge
..\runtime\node\node.exe ..\runtime\node\npm\package\bin\npm-cli.js ci
cd ..
runtime\node\node.exe --import ./worker/test/fixtures/offline-network.mjs --test worker/test/bridge-userscript.test.mjs
```

脚本里的字段白名单是 `worker/src/shared/normalizers.mjs` 中 `DOUYIN_BRIDGE_FIELDS` 的副本，两边要一起改。

参考：[Tampermonkey 文档](https://www.tampermonkey.net/documentation.php)（sandbox、GM_xmlhttpRequest、GM_addElement）。
