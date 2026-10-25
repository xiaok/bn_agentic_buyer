# Agent Trade · Chrome

独立的 Chrome Manifest V3 扩展。安装后可在 Four.meme、Flap、Gang 页面使用买入按钮；不需要本机 Node 服务、Hermes 或 Grok。原 `skills/agent-trade/` 和已交付的 agent ZIP 保持不变。

默认买入 **0.001 BNB**，交易及换币滑点各 **1%**，gas 另计。真实订单跳过额外本地试买；Binance 强制的 preview / execute、App 风险确认继续保留。

## 安装已编译版本

1. 下载并解压本仓库，或 clone 到本机。
2. Chrome 打开 `chrome://extensions`，打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录下的 `unpacked/` 文件夹，其中已有 `manifest.json` 和完整构建文件。
4. 点击扩展图标，打开设置与订单页面。

也可以解压 `dist/agent-trade-chrome.zip`，加载其中的 `agent-trade-chrome` 文件夹。

两种方式均不需要安装 Node、pnpm、编译源码或启动其他程序。每位使用者首次安装后，连接自己的钱包。

## 首次初始化连接

1. 在扩展页面点击“连接 Binance Agentic Wallet”。
2. 用 Binance App 扫描扩展显示的二维码，在 App 核对同一配对码并确认连接。配对码只用于核对，无需输入；也可点击链接打开 Binance 官方扫码页。二维码由扩展在本地生成，内容与 Binance 返回的登录链接完全一致。
3. 扩展轮询配对状态，成功后显示 **完整 BSC 钱包地址**。核对它是否为你准备使用的钱包。
4. 查看 Developer Mode 状态；未开启时，在 Binance App 的 Agentic Wallet 设置中开启。检查 App 的允许交易 token 范围与限额。
5. 默认金额为 0.001 BNB，可在扩展里修改。

这是新客户端的独立会话，不会读取、导出或覆盖 Hermes 的本地会话。连接返回哪个钱包，以 App 和扩展显示地址为准；不能凭同一 Binance 账号就假定是同一地址。

关闭设置页面后会话仍保存在 Chrome 的扩展专属存储。会话过期后重新连接。扩展里的“退出扩展会话”只处理该扩展客户端，不读取 CLI 的凭据。

## 点击交易

- token / Market 详情页右下角显示完整地址和“买入 0.001 BNB”。一次点击即执行。Four、Gang 优先读取当前 token URL；Flap 详情读取明确标注的“Market 地址”。
- Four、Gang 列表的 token 链接旁也显示买入按钮；Flap 列表卡片通过当前页面的 Market 地址 key 绑定各自按钮。悬停条目按钮时，右下角显示对应完整地址。
- 支持三个平台的链上归属识别，按原确定性交易逻辑处理必要换币、授权、Flap claim 与 BNB 结算。
- 页面没有可核对的地址、含冲突地址或前端结构变化时停用对应按钮，不会用名字或列表顺序猜币。通常打开该币详情即可；设置页面手动输入仅作为备用入口。
- 点击后立即显示提交中提示，链上确认后弹出“买入成功”或“卖出成功”及交易链接；失败会显示原因，待确认不会显示成功。
- 订单页每笔成功买入旁提供“卖出 25% / 50% / 全部”，直接使用该订单的地址，无需再粘贴。比例按当前钱包中该币的持仓计算，而不是单笔买入数量；Flap 内盘按 shares 比例卖出。存在未完成订单时，快捷卖出暂时禁用。
- 设置页面与网页悬浮面板都有 Gang / Flap / Four 快捷入口，新标签页打开。
- `BROADCASTED` 仅表示提交；界面出现“买入成功 / 卖出成功”（日志 `SUCCESS`）才表示交易及必要结算已确认。
- App 确认、RPC 超时、浏览器中断后，使用“继续原订单”。不要通过新买入重试。没有可跟踪 hash / orderId 的不确定提交会停止，不盲重发。
- 卡住且已结束当前后台调用时，可在订单旁点“强制解除本地锁”，阅读并确认风险后恢复新买卖。它不调用 Binance 或链上接口、不撤销已提交交易、不判定原单成功与否；原订单、错误、哈希和订单号完整保留，原单此后禁止继续执行。已提交交易仍可能成交，重新下单可能重复买卖。正在执行的后台调用不能直接解锁，避免旧任务与新订单并发。
- 历史恢复请求使用官方 HTTP 参数 `binanceChainIds`、分页数量与时间范围；精确匹配 `orderId` 或 `binanceTxId` 后，仍核对链上回执及合约调用，不能将授权交易误当成卖出完成。

## 实现与权限

交易逻辑在 `src/engine/`，是原 agent 0.1.0 的独立快照。Chrome 版将文件日志改为扩展存储，并在 execute / swap 前 **等待日志写入完成**。新旧版本没有共享状态目录，Chrome 与 CLI 对同一钱包同时发单仍可能竞争钱包 nonce；本扩展不自动向另一个进程排队下单。

`src/baw.mjs` 按官方 BAW **1.12.0** 发布包移植 HTTP 客户端。它不是官方浏览器 SDK。原生文件系统、系统钥匙串和进程入口均未打入扩展；登录配对用的公钥不承担钱包交易签名，MPC 由原 Binance 服务处理。

- `storage`：配置、扩展会话和恢复日志。设置为 `TRUSTED_CONTEXTS`，网页内容脚本不能直接读取。
- `webRequest`：仅观察由本扩展发往 Binance API 的响应，捕获浏览器 fetch 不可读取的 `agentSessionId` Set-Cookie。
- `declarativeNetRequestWithHostAccess`：仅给本扩展发往 Binance API 的请求附加该扩展会话。普通网页、其他扩展不匹配这个规则。
- 网络权限只包含 Binance API 和固定 BSC RPC；按钮仅注入三个指定网站，不接收网页 `postMessage` 下单。

所有 API 请求从扩展后台执行。没有外部服务、远程脚本、私钥输入、shell、eval 或 LLM 调用。没有将会话放入页面 DOM / localStorage。服务端接口版本、风控与地区可用性仍由 Binance 决定。

Flap 的 `flap-bindings.js` 是仅在该应用入口运行的只读 MAIN-world 页面适配器，只读取卡片当前 React key 并标记 Market 地址，不调用钱包、不发送订单。凭据与点击执行仍位于独立的扩展上下文。该页面结构已在本次公开页面中核对；网站更新后可能需要重新适配。

## 源码构建

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test
```

加载生成的 `unpacked/`。Node 只用于开发构建，生成的扩展不依赖 Node。

## 验证边界

自动测试和 Chrome 测试使用模拟钱包验证连接、会话、金额、提交恢复和按钮行为。用户已在自己的 Chrome 完成真实配对及一笔 0.0001 BNB 买入，公开 BSC 回执状态为成功，且对应 token 的转入日志与当前余额一致。该单例不能证明三个平台所有内外盘、卖出、换币、恢复及风控分支均已实盘验证，详见 `VALIDATION.md`。

## 来源

- 官方 BAW CLI：`@binance/agentic-wallet@1.12.0`，移植登录、Cookie、钱包列表、设置、合约 preview / execute 与普通换币接口。
- [官方 Binance skill 与 references](https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet)。
- Four / Flap / Gang 的原始来源、固定 blob 与 ABI 快照见原项目 `RESEARCH.md` 和 `skills/agent-trade/references/operations.md`。
- 原 agent 的完整文件 SHA256 保存在 `agent-original-sha256.json`，用于验证原版未被修改。

接口与来源审阅日期：2026-10-25。扩展版本 0.1.1。
