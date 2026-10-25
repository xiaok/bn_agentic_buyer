---
name: agent-trade
description: 执行用户的 agent buy / agent sell 命令，通过已有 Binance Agentic Wallet 会话交易 BSC 上的 Four Agent ID、Flap Agent Curve 和 Gang。默认买入 0.001 BNB；用于明确下单指令，不用于选币、推荐、行情研究或条件单。
---

# Agent Trade

收到 `agent buy <address> [BNB]` 或 `agent sell <address> <50%|all|数量>`，立即调用本 skill 的确定性脚本。标准路径是一次脚本调用及一条简短结果；平台识别、报价、换币、授权、下单和确认由脚本完成。

## 调用

将 `<skill-dir>` 替换为本 SKILL.md 所在目录，保留用户给出的买卖方向、完整地址和数量：

```bash
node <skill-dir>/scripts/agent.mjs buy <address> [BNB]
node <skill-dir>/scripts/agent.mjs sell <address> <50%|all|数量>
```

金额/地址按独立参数传递，不使用 eval。买入金额省略即 **0.001 BNB**；初始滑点 **100 bps = 1%**。命令可用 `--slippage-bps N` 覆盖，资金兑换另用 `--swap-slippage-bps N`。卖出必须有数量或比例。BNB 支付预算不含链上 gas。

用户发出明确的 `agent buy` / `agent sell` 命令，即要求执行该笔订单及其必要的授权、换币、wrap/unwrap、Flap claim 步骤。正常路径直接执行，不另加一轮“是否确认”。遵守宿主强制审批与 Binance 的风险拦截、App 确认。

真实下单**不额外执行本地试买 eth_call**。必要的状态/报价查询与 Binance 强制 `preview → execute` 由脚本自动处理。`--dry-run` 仅在用户明确要求只读检查时添加。

执行前不做选币、行情分析、推荐、网页搜索、读取官方交易 manuals 或调用其他交易 skill。需要维护脚本或解释错误时再读 [操作说明](references/operations.md)。

## 一次安装

复制整个 `agent-trade` 文件夹到 Hermes 的 skills 目录。需要 Node ≥22 和 pnpm。在本 skill 目录执行一次：

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

复用 Hermes 环境里已有的 `baw`，保留其 `HOME`、`BINANCE_BAW_DIR` 及系统钥匙串。不要创建单独的钱包会话。已有 `CONNECTED` 会话直接交易；缺少 `baw` 时提示安装 `pnpm add -g @binance/agentic-wallet@1.12.0`，不反复尝试其他钱包工具。

## 结果处理

- `SUCCESS`：一句话报告买入/卖出已确认及 `txHash`；实际数量只取脚本返回的事件/到账数据。
- `AUTH_PAIRING`：原样显示 `pairingCode`、`urlForWeb`；保留进程运行，直到用户在 Binance App 配对完成。
- `APP_CONFIRMATION` / `PENDING_CONFIRMATION`：简短提示 App 确认，保留 `operationId`。用户说已确认时运行 `node <skill-dir>/scripts/agent.mjs resume <operationId>`。
- `PENDING`：用 `status <operationId>` 查询；需要继续原来的换币/交易步骤时用 `resume <operationId>`。
- `SUBMISSION_UNKNOWN`：只查原订单/哈希，不重复提交。脚本会阻止不确定状态下的新订单。
- 其他错误：简短报告原始错误及 operationId，然后停止。不要自动重新运行 buy/sell、提高金额/滑点、切平台或回滚资金。

`operationId` 来自脚本真实输出，不能编造。确认交易以 receipt / `FINISHED` 为准，不能将报价、preview 或 orderId 当作成交。
