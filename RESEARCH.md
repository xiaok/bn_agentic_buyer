# 三个平台统一交易 CLI 调研与实现规格

调研日期：2026-10-25（Asia/Tokyo）。范围：Four.meme Agent ID 专属模式、Flap ID Agent Curve、Gang.fun。CLI 与可复制 Hermes skill 已实现在 `skills/agent-trade/`，默认买入 0.001 BNB，真实下单跳过额外本地试买模拟；未连接用户钱包或执行真实交易。验证范围见 [交付验证](research/SKILL-VALIDATION.md)。

## 结论

可行。采用确定性 CLI + 平台适配器 + Binance Agentic Wallet 执行层。文档、ABI、地址发现和单位换算写进程序，交易时不再让 LLM 现场读文档和组命令。

用户只输入地址，程序以链上注册信息识别平台及市场阶段，然后报价、处理支付资产、授权、BAW preview、执行、确认结果。三个平台共享签名层，不能共享同一套内盘交易接口。

统一语义：

- `buy` 的金额始终是 BNB 预算；省略金额时读取用户配置的默认买入金额。
- `sell` 的输入是明确的持仓比例、数量或 `all`；默认收取 BNB。
- 内盘要求其他报价币时，买入自动编排 `BNB → 报价币 → 内盘`，卖出编排 `内盘 → 报价币 → BNB`。
- 用户允许用其他持有资产支付时，可先执行 `允许的支付资产 → BNB`。只使用配置允许的资金来源。
- 配置提供默认金额与默认滑点，命令参数覆盖配置。不会因需要参数而每次进入 AI 对话。
- BNB 预算包含买入支付及协议扣费；链上 gas 另计。可能受持仓上限而少花，必须返回实际花费及退款。

## 1. 已确认的关键事实

### Binance Agentic Wallet

官方执行入口是 `baw` CLI，包名 `@binance/agentic-wallet`。Agent ID 的 `.ai` 是链上身份的展示形式；不能用普通域名文本证明钱包持有交易资格。

连接流程：

```text
baw auth signin --json
  → 展示 pairingCode，打开返回的原始 urlForWeb
  → 用户在 Binance App 配对
baw auth verify --qrCodeId <id> --json
  → 必须保持进程运行直到完成
baw wallet status --json
  → 验证 CONNECTED
```

会话可以复用，但会过期，也会因不活跃退出。读取 `wallet settings` 中的 `sessionExpireTime`、`inactiveSignOutTime`，不要把示例的 48h 写死。

自构建交易通过 Developer Mode 执行：

```text
contract-call preview --binanceChainId 56 --from <wallet>
                      --to <target> --value <wei> --inputData <hex> --json
  → requestId + simulationResult + risks + requireConfirmation + expiresAt
contract-call execute --requestId <id> --json
  → BROADCASTED / PENDING_CONFIRMATION
```

Developer Mode 只能在 App 开启、配置，有独立限额和有效期。`--value` 是 wei，`0.01 BNB = 10000000000000000 wei`。`requireConfirmation=true` 需要 App 批准，封装 CLI 无法保证每笔都免 App 确认。

普通兑换可用 `baw market-order quote / swap / list`。其金额是人类可读单位，与 `contract-call --value` 不同。`BROADCASTED` 和 `success:true` 均不是成交证明；普通订单等 `FINISHED/FAILED`，合约交易等 receipt。

### 三个平台对比

| 项目 | Four Agent ID | Flap Agent Curve | Gang |
| --- | --- | --- | --- |
| 归属依据 | Registry → Core 的 token 登记，presetId | Factory 的 Market/token 登记 | 各版本 Launchpad 的 curves(token) |
| 内盘持仓 | 已部署 ERC20 的持仓 | Market 里的内部 shares | 已部署 ERC20 的持仓 |
| 输入地址 | token | Market / 预测 token / 已发射 token | token |
| 买入 | Core buyByBudget | Portal buy / buyWithQuote | Soft payable buy；V2 quote-token buy |
| 卖出 | Core sell，可能先 approve | Portal sellBps，不需 shares approve | Launchpad sell，通常先 approve token |
| 发射后领取 | 本次流程无额外 claim | shares 需 claim 换成实际 token | 按版本/具体合约能力处理 |
| 退出资产 | BNB 或 quote，取决于路径 | BNB 或 quote | Soft 为 BNB；V2 为 quote，WBNB 也不是原生 BNB |
| 买卖资格 | Agent ID 买；卖也有身份/发行者规则 | 买需 Agent ID；卖/claim 不需 | 当前 V2 的 buy 和 sell 源码均调用身份检查；旧版本不同 |

身份、上限、暂停和阶段必须按当前合约验证；不能把某一平台的规则推广到另外两家。

## 2. Four.meme Agent ID 适配器

入口：[用户提供的专区](https://four.meme/zh-TW/contract/1778027615735)。模式 presetId 为 `1778027615735`。

Binance 官方已经提供 `scripts/agent-id-exclusive-token-launches.mjs`，支持 `info`、`quote-buy`、`quote-sell`、`receipt`，只读并构建 calldata，不签名、不广播。应固定审阅过的版本，复用其报价、身份、阶段和退款处理，不在每笔交易时重新下载或解释文档。

发现入口是 BSC Registry `0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94`。Core、Tools 从 Registry 读取，不能把本次观察到的 Core 地址作为长期常量。

流程：

1. `info(token)` 检查登记、presetId、phase、暂停和迁移状态。
2. 内盘 `Trading` 时用 `quote-buy(amount=BNB预算)`；卖出用 `quote-sell`。
3. 如果返回 approveTx，执行授权、等待确认，然后重新报价。
4. 将返回的 `tx.to / tx.value / tx.inputData` 原样交给 BAW preview/execute。
5. receipt 解码实际购买数量、支付和退款。

该模式有 1% 持仓上限；预算买入可能退款。官方脚本默认滑点是 **20%**，统一 CLI 必须传入自己的配置值，不能不经意继承这个默认值。

已迁移时重新选择外盘路线；迁移中、暂停或不支持的阶段明确返回状态。普通 Four 旧 TokenManager 路线不是本次 Agent ID 专区接口。

**实测**：BSC 区块 `129696652`，用户示例 `0xc56a0cebf544fcb149798bf39f4acd7fbd22ffff` 的链上 symbol 为 `大肥鱼`，presetId 匹配、`phase=Trading`、`market=inner`、`route=contract-call`，报价资产是 WBNB，脚本支持原生 BNB 支付。

## 3. Flap ID Agent Curve 适配器

入口：[Flap Agent Curve](https://flap.sh/apps/agent-bonding-curve?lang=zh)。页面市场详情内有完整英文交互规范，本次也读取了页面公开组件及 i18n 规范。

当前官方页面给出的合约：

| 合约 | 地址 |
| --- | --- |
| Factory | `0xC55820f24015bE7c4f18949D9e1363A3609B300e` |
| Agent Portal | `0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062` |
| Reader | `0x18Aa6C93f1887a243fdc348C9A77F5136555174a` |
| 后续普通 Flap Portal | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |

### 地址识别已经有直接链上接口

```solidity
Factory.isMarket(address) returns (bool)
Factory.marketOfToken(address) returns (address)
Factory.probeOfMarket(address) returns (address)
Reader.probeOfToken(address) returns (address)
Probe.market() returns (address)
```

先尝试输入是否为已登记 Market，否则用 `marketOfToken` 反查。得到 Market 后核验 Factory、Probe 与 Market 的绑定，再读市场状态。预测地址即使没有 bytecode，也可能是完全有效的内盘入口；不能一上来用 `getCode(token)==0x` 排除它。

已验证的样本：

```text
预测 token  0xfC0f0592eDCC6E96efb5Fb5E9CA48db3fb757777
Market      0x05cfb64282bF8f9CF5AFeB9fe38F7354fEd094F0
Probe       0xa56EFB142E712d8e2dcD15854C5EbD9FaDd47e86
```

Factory 正确反查 Market，Reader 正确反查 Probe；预测 token 的 `getCode` 为 `0x`。区块 `129696652` 的 Probe 返回 `PHASE=1`、原生 BNB quote，市场门槛为 5 BNB。这些数值是样本快照，程序应动态读取。

### 报价读取方式特殊

`*Probe()` 有意通过 `Error(string)` revert 返回 `KEY=VALUE;...;END`，不是普通 view 返回值。它只能 `eth_call`，不能广播。解析器要解码 revert data，验证完整字段及 `;END`，缺失/截断保留 unreadable，不能按零处理。

原生 BNB 买入：

```text
assetProbe → actionStatusProbe / buyCapacityProbe
→ buyPlanProbe(grossWei, slippageBps)
→ Portal.buy(Market, MIN_SHARES), value=grossWei
```

ERC20 quote 买入：

```text
quoteFundingProbe(grossRaw)
→ 必要时 quoteToken.approve(MARKET, grossRaw)，等确认
→ buyPlanProbe(grossRaw, slippageBps)
→ Portal.buyWithQuote(Market, grossRaw, MIN_SHARES), value=0
```

**此处 approve spender 是 Market，不是 Portal。** 需要覆盖完整 grossRaw，即使报价预计退款。CLI 从 BNB 出发时，要先把 BNB 兑换为 quote，再用本次实际到账数量重新报价。

内盘卖出：

```text
positionProbe
→ sellPlanCustomProbe(shareBps, slippageBps)
→ Portal.sellBps(Market, shareBps, MIN_WEI或MIN_RAW), value=0
```

百分比卖出可作为三平台通用入口。Flap shares 固定 18 decimals，但不是 ERC20，不查预测 token 的 balanceOf 充当内盘余额。

`PHASE=3` 表示 Agent Curve 已发射，不能据此直接断言已经进入 Pancake DEX。应读取实际 token、claimable 与普通 Flap Portal 的 `getTokenV8Safe` 状态，再决定普通 Flap 曲线/外盘交易。claim 与 sell 分别记录；组合退出可编排，但每步各有 receipt，不能宣称原子执行。

## 4. Gang 适配器

入口：[Gang](https://gang.fun/)，官方仓库 [gangfun/cli](https://github.com/gangfun/cli)。

**文档版本有明显差异。** 旧网站指南及 gang-launchpad README 仍展示 v4.1/20 BNB/旧 CLI；本次读取的 CLI 主分支 README 是 `0.4.0`，使用新 LaunchpadV2，并兼容 Soft/U/S 交易。不要按搜索摘要或旧指南写死合约和交易资格。

当前 CLI 定义的交易合约：

| 分支 | 地址 | 交易结构 |
| --- | --- | --- |
| V2 | `0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E` | ERC20 quote |
| Soft | `0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7` | 原生 BNB |
| U | `0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb` | ERC20 quote |
| S | `0x60aee38576035E757deD30fF8db8A8DA476430C1` | ERC20 quote |

自动识别对以上经过版本管理的合约并行读取 `curves(token)`，要求 `creator != 0`；同时解码对应 ABI，不以 token 自称的 launchpad() 作为唯一依据。旧 v4.1 等额外历史合约若要交易，应增加明确的版本适配及验证，不能把它们与当前四个分支混成一个 ABI。

Soft 买入为 payable `buy(token,minTokensOut)`；V2 为 nonpayable `buy(token,quoteIn,minTokensOut)`，要先持有并授权 quote。WBNB quote 需要 wrap，卖出得到 WBNB 后要 unwrap 才是 BNB；其他 quote 要独立兑换。

**官方 CLI 参数陷阱**：V2 的 `gang buy --bnb N` 实际是 N 单位 quote，不保证是 BNB。其当前 `quoteBuy` 使用 `parseEther`，统一实现必须按 quote 的实际 decimals 处理，不能直接透传用户 BNB 预算或照抄这个单位假设。

当前 V2 没有相同的链上 quoteBuy view，官方客户端按 Solidity 曲线算法计算；复用算法前要和实际合约版本匹配。按用户要求不额外执行本地 exact calldata 试买，保留 BAW 强制 preview。当前 V2 源码中 buy/sell 都调用 `_requireAgent()`，与旧文档的“任何持有者可卖”不同。以实际目标合约为准。

实测 V2 的 `allTokens(0)` 为 `0xD2e747091932785c5b63afBb8653f2520a782EFA`；其 curves 注册非零，quote 是 GANG `0x0c6302401aa5325C2E36F170f52C00B1d220B405`，尚未毕业。Four 示例地址在 V2 的 creator 为零，能正确排除。

## 5. 兼容层结构

```text
CLI / 可选 AI 意图入口
  ↓
Resolver：chain + address → 平台 + Market + 阶段 + 证据
  ↓
Adapter：Four / Flap / Gang（每个包含已支持的版本）
  ↓
FundingPlanner：统一 BNB 预算、换币、wrap/unwrap、approve、claim
  ↓
WalletExecutor：baw preview/execute + market-order
  ↓
Settlement：receipt / 订单状态 / 实际资产及份额变化
```

适配器提供 `detect`、`readState`、`readPosition`、`quoteBuy`、`quoteSell`、`buildBuy`、`buildSell`，可选 `buildClaim`；只生成交易计划。所有签名、执行与日志由统一执行器处理。

核心数据不要只放一个 tokenAddress：

```typescript
type MarketRef = {
  chainId: 56;
  platform: 'four-agent-id' | 'flap-agent-curve' | 'gang';
  version: string;
  inputAddress: string;
  marketAddress: string;
  tokenAddress: string | null;
  predictedTokenAddress?: string;
  quoteToken: string; // 原生资产用统一内部标识，适配器转换
  quoteDecimals: number;
  phase: 'curve' | 'transitioning' | 'launched' | 'dex' | 'paused' | 'unavailable';
  positionKind: 'erc20' | 'internal-shares';
  observedBlock: bigint;
};
```

`Match`、`NoMatch`、`RpcError`、`UnsupportedVersion` 必须区分。识别不确定、多个合约意外冲突或 RPC 失败都不能默认转给外盘。内盘失败不代表外盘可交易。

Resolver 首次并行读取三平台登记，用 Multicall/批量 RPC；只缓存平台归属和长期元数据，阶段、额度、余额、allowance、报价和最小到账每次重新校验。缓存以 `chainId + address` 为键。

## 6. BNB 统一结算和默认值

已实现命令（Hermes 通过 skill 调用脚本；手动在 skill 目录使用 `pnpm agent ...`）：

```bash
agent connect
agent config set buyAmountBnb 0.001
agent config set slippageBps 100

agent inspect <address>
agent buy <address>                 # 用配置的 BNB 金额和滑点
agent buy <address> 0.02             # 金额覆盖默认值
agent buy <address> 0.02 --slippage-bps 300
agent sell <address> 50%
agent sell <address> all
agent buy <address> 0.001 --dry-run --from <public-address>
agent status <operation-id>
agent resume <operation-id>
```

初始配置已设置为 `0.001 BNB` 和 `100 bps=1%`，未经实盘成交率测试。卖出必须明确提供比例、数量或 all，不能把缺省卖出解释成全部卖出。

配置优先级：命令参数 > 用户配置 > 明确的初始化默认值。分开配置内盘滑点和资金兑换滑点；所有金额使用十进制字符串 + bigint，超出精度报错，不经浮点数计算。

### 买入其他报价币池

```text
0.001 BNB 预算
→ BNB→quote 兑换（WBNB 则 wrap）
→ 等待实际到账
→ 以本次获得的 quote 数量重新读取内盘状态和报价
→ 必要时 approve，确认后再次报价
→ 内盘买入
```

跨步骤总花费受 BNB 预算约束；不动用已有 quote 持仓偷偷扩大买入。兑换和内盘各有滑点，结果展示整条路径的最低预期、费用和实际花费。失败后可能留下 quote/WBNB，这属于部分完成，不能报“全部撤销”或自动再买一笔。

### 卖出默认回 BNB

```text
确定要卖的 ERC20 / shares
→ 必要时 claim / approve
→ 卖回平台 quote
→ 只处理本次实际收到的 quote（WBNB 则 unwrap）
→ 兑换为 BNB
```

若兑换不被 BAW 支持或流动性不足，返回明确状态和已经完成的步骤。Flap 发射后只有 shares 时，需形成明确的 claim→实际 token 出售计划；不能把未领取份额当作可花 ERC20。

### 一条命令与确认

程序可以连续处理多个步骤，但它们通常不是原子交易，也不一定只需一次签名。用户可在明确设置执行模式、默认预算及滑点后直接运行 buy/sell；CLI 不再调用 LLM 逐项决定参数。BAW preview、风险拦截及要求的 App 确认仍保留；新风险、超出配置范围或市场阶段改变要重新评估，不能自动扩大金额或滑点。

## 7. 速度与可靠性

要消除的是 LLM 每笔读文档、查地址、计算单位、串行试错的时间。热路径只有确定性查询、报价、必要兑换/授权与 BAW preview/签名；没有额外本地试买模拟。

- 初次连接完成身份、链、Developer Mode、会话有效期检查，复用 BAW 会话。
- RPC 连接复用、独立读取并行；Registry 与版本变化触发元数据失效。
- 明确的 BNB 原生路径应少查无关余额，不跑全市场发现/排行榜。
- 卖出首次授权、BNB→quote 兑换、多步 claim、App 确认、网络及出块耗时无法消除。
- 不承诺“毫秒成交”或固定秒数；分别记录发现、报价、preview、execute、上链和最终兑换耗时，实测后给分位数。
- 每笔生成 operationId，按步骤持久化 requestId、txHash、orderId。执行超时后先查状态；不得盲重发。
- approve 只对已验证 spender 及本次所需金额，之后重新检查 allowance；不因赶速度强行用无限授权。

## 8. 实现与验收顺序

1. 固定本次审阅的文档、合约地址及 ABI，建立版本配置。Node 22+，TypeScript/viem，包管理统一 pnpm。
2. 先实现 inspect/resolver；三个正例及跨平台负例、Flap 无 bytecode 预测地址都应正确识别。
3. 实现只读 quote/build 与 BNB 统一预算 FundingPlanner；支持 native、WBNB、ERC20 quote。
4. 实现 BAW connect/session、preview/execute、逐步日志与恢复，支持用户默认参数。
5. 覆盖三家的买卖与必要的授权、Flap claim、外盘状态识别，执行后确认实际变化。
6. 离线验证精度、不同 decimals、份额百分比、限额退款、Probe 完整性、阶段切换、超时不重复下单；用可控 fork 或明确授权的小额测试验证多步执行。

当前已完成调研、官方来源快照、CLI/skill 实现、22 项自动测试、只读链上验证及下述只读测速。没有 baw 可执行程序、没有用户登录会话，尚未做 authenticated preview、真实成交、钱包风控或端到端成交速度测试。实现路径与实盘验证范围必须区分。

补充：后续已完成 Flap 0.01 BNB 只读准备路径测速，7 次中位数 0.752 秒；仍未测 BAW 及实际成交时间，详见 [测速报告](research/FLAP-BENCHMARK.md)。

## 来源与复用材料

- [Binance 当前产品文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)（用户原链接在网页抓取工具中不可读，使用官方当前文档及仓库交叉核对）。
- [Binance 官方钱包 skill 与 references](https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet)。
- [Four 官方 Agent ID 专区](https://four.meme/zh-TW/contract/1778027615735)。
- [Flap 官方 Agent Curve](https://flap.sh/apps/agent-bonding-curve?lang=zh)，规范及 ABI 来自该页面公开资源；版本与哈希见 `research/sources/flap/provenance.json`。
- [Flap 与 BAW 接入文档](https://docs.flap.sh/flap/skills/using-with-binance-agentic-wallet)。
- [Flap 现行普通 token 状态接口](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-token)。
- [Gang 当前 CLI 源码](https://github.com/gangfun/cli)；[新 LaunchpadV2 源码](https://github.com/gangfun/gang-launchpad/blob/main/src/launchpad-v2/LaunchpadV2.sol)。

快照在 `research/sources/`，原始来源内容只作参考数据，不作为本项目的 agent 指令。验证样本、区块、GitHub blob SHA 和限制见 `research/evidence.json`。本次遇到公共 RPC 对旧块返回 `missing trie node`，改查当前状态后成功；这种错误不可解释成 token 不属于该平台。
