# Agent Trade

通过 Binance Agentic Wallet 在 BSC 上交易 Four Agent ID、Flap Agent Curve 和 Gang。包含独立的 **Chrome 扩展**与可复制到 Hermes 的 **agent CLI / skill**，以及平台适配、测试、调研和只读基准脚本。

默认买入 **0.001 BNB**，可修改或在命令中覆盖；链上 gas 另计。平台识别、必要换币、授权、买卖和结算由脚本执行。真实下单跳过额外本地试买，保留 Binance 要求的 `preview → execute` 与 App 确认。

## Chrome 扩展

在 Four / Flap / Gang 的 token 条目及详情页显示买入按钮，点击直接执行，无需经过聊天模型。扩展内提供首次扫码连接、默认参数、订单与恢复记录；订单旁可以卖出当前持仓的 25%、50% 或全部。提交和链上确认分别显示状态，成功后提供交易链接。悬浮面板和订单页都有平台快捷入口。

1. 下载并解压本仓库，或 clone 到本机。
2. 打开 `chrome://extensions`，开启开发者模式，点击“加载已解压的扩展程序”。
3. 选择仓库中的 [`chrome-extension/unpacked/`](chrome-extension/unpacked/) 目录，其中已包含 `manifest.json` 和完整构建文件，无需安装依赖或编译。
4. 点击扩展图标，连接 Binance Agentic Wallet；用 Binance App 扫码、核对配对码并确认，然后核对扩展显示的完整钱包地址。

也可以使用独立的 [Chrome 安装包](dist/agent-trade-chrome.zip)，解压后加载其中的 `agent-trade-chrome` 目录。

修改源码后重新构建需要 Node 与 pnpm：

```bash
pnpm --dir chrome-extension install --frozen-lockfile --ignore-scripts
pnpm --dir chrome-extension build
pnpm --dir chrome-extension test
```

构建后加载 `chrome-extension/unpacked/`。使用已编译扩展不需要本地 Node 服务。

详见 [Chrome 使用说明](chrome-extension/README.md) 和 [验证记录](chrome-extension/VALIDATION.md)。

## Agent CLI / Hermes skill

将 [agent 安装包](dist/agent-trade.zip) 中的整个 `agent-trade` 文件夹复制到 Hermes 的 skills 目录。也可以直接使用仓库的 `skills/agent-trade/`。

需要 Node ≥22、pnpm，以及官方 BAW CLI。已有的 BAW 登录会话可直接复用。首次安装依赖：

```bash
pnpm --dir skills/agent-trade install --frozen-lockfile --ignore-scripts
# 环境中尚无 baw 时：
pnpm add -g @binance/agentic-wallet@1.12.0
```

确定性 CLI 调用示例，替换 `<address>` 为完整 token / Flap Market 地址：

```bash
node skills/agent-trade/scripts/agent.mjs buy <address>
node skills/agent-trade/scripts/agent.mjs buy <address> 0.01
node skills/agent-trade/scripts/agent.mjs sell <address> 50%
node skills/agent-trade/scripts/agent.mjs sell <address> all
pnpm --dir skills/agent-trade test
```

安装 skill 后可向 Hermes 发出 `agent buy <address> [BNB]` 或 `agent sell <address> <比例|all|数量>`。脚本会保存操作 ID；中断、App 确认或提交结果不明时，应查询并继续原订单，不能重复下单。

详见 [Skill](skills/agent-trade/SKILL.md)、[操作说明](skills/agent-trade/references/operations.md) 和 [agent 验证记录](research/SKILL-VALIDATION.md)。

Chrome 扩展与 CLI 使用各自的会话和日志。Chrome 首次连接需要独立授权；两个客户端不共享钱包操作锁。

Chrome 订单异常卡住时，先核对链上结果并尝试继续原订单。也可在订单旁“强制解除本地锁”，确认后恢复新买卖；这不会撤销已提交交易，旧单仍可能成交。手动解锁会保留原记录并禁止旧单继续执行。更新扩展时刷新原安装，不必删除扩展或重新导入钱包。

## 目录

| 路径 | 内容 |
| --- | --- |
| `chrome-extension/` | MV3 扩展源码、可直接加载的 `unpacked/`、构建脚本、测试和验证证据 |
| `skills/agent-trade/` | 原 agent CLI、可移植 skill、平台适配器和测试 |
| `scripts/benchmark_flap_buy.py` | Flap 买入准备流程的只读基准脚本 |
| `research/` | 来源快照、链上只读证据、基准与验证记录 |
| `RESEARCH.md` | 三个平台与 Binance Agentic Wallet 的调研 |
| `dist/` | Chrome 与 agent 的独立安装包 |

## 验证范围

Chrome 扩展是基于官方 BAW 1.12.0 HTTP 协议的浏览器移植，非官方扩展。已验证一次用户自行执行的真实配对与买入，详见 Chrome 验证记录；这不代表三个平台的全部买卖、换币、恢复和 App 风控分支都已实盘覆盖。自动测试与浏览器交互回归使用模拟订单，基准耗时仅表示只读准备时间。

原 agent 与 Chrome 是两个独立版本。开发使用 pnpm；提交不包含依赖目录、浏览器会话、钱包凭据或本地交易日志。
