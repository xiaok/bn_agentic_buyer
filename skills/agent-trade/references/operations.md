# 安装与操作

这是完整的可复制包。需要 Node ≥22、pnpm、已有官方 `baw`，针对 BAW 1.12.0 开发。安装本包不会安装另一份钱包或替换已有会话。

```bash
cd ~/.hermes/skills/agent-trade
pnpm install --frozen-lockfile --ignore-scripts
node scripts/agent.mjs config
```

Hermes 使用完整脚本路径，无需安装名为 agent 的全局命令。手动终端可在本目录用 `pnpm agent buy ...`。

## 配置

```bash
node scripts/agent.mjs config set buyAmountBnb 0.001
node scripts/agent.mjs config set slippageBps 100
node scripts/agent.mjs config set swapSlippageBps 100
node scripts/agent.mjs config set rpcUrl https://bsc-dataseed1.bnbchain.org
node scripts/agent.mjs config set bawBin /absolute/path/to/baw
```

状态默认在 `~/.agent-trade/`，可通过 `AGENT_TRADE_HOME` 覆盖。`AGENT_TRADE_RPC_URL` 和 `AGENT_TRADE_BAW_BIN` 覆盖 RPC 和 baw 路径；不会修改 `BINANCE_BAW_DIR`、HOME 或读取私钥。命令参数优先于用户配置。

## 命令

```bash
node scripts/agent.mjs inspect <address>
node scripts/agent.mjs buy <address>
node scripts/agent.mjs buy <address> 0.002 --slippage-bps 200
node scripts/agent.mjs sell <address> 50%
node scripts/agent.mjs sell <address> all
node scripts/agent.mjs connect
node scripts/agent.mjs status <operationId>
node scripts/agent.mjs resume <operationId>
node scripts/agent.mjs buy <address> --dry-run --from <public-simulation-address>
```

Flap 内盘持仓为 shares，用比例或 all 卖出；ERC20 持仓可传明确数量。只有明确要求只读检查时加 `--dry-run`，它不调用钱包写接口，也不执行额外试买。`--from` 仅允许只读模式；真实钱包地址来自 BAW。

## 支持路径

- Four Agent ID preset 1778027615735：官方 Core/Tools 报价构造，Registry 动态发现地址，内盘买卖与已迁移 DEX。
- Flap Agent Curve：Market/预测 token/实际 token 反查，Probe 完整 revert 解码，BNB 和 ERC20 quote 内盘、份额卖出、发射后 claim 与普通 Flap 曲线/DEX。
- Gang：V2、Soft、U、S 及旧 v4.1 分支，native、WBNB 与 ERC20 quote。V2 使用经核对的整数曲线算法。
- 非 BNB quote：仅使用本次 BNB 预算兑换的实际到账买入，授权后重新报价。卖出及买入剩余 quote 换回 BNB，WBNB 用 wrap/unwrap。钱包须有足够原生 BNB 覆盖预算及 gas，不会自行挑选、卖掉其他持仓补款。

多步交易不是原子操作。后续失败可能留下 quote/WBNB/token；返回已完成步骤与原始错误，不自动反向回滚或重买。已有足额 allowance 可复用。

## 登录与风控

真实交易复用已有 BAW 会话；未连接时发出 AUTH_PAIRING 并保持 auth verify 运行。失败或超时停止，不无限重试。Developer Mode、交易 token 范围及限额在 App 管理。BAW preview 包含后端模拟/风险检查，这是官方必需步骤，脚本不绕过。

## 超时与继续

提交前持久化意图与提交状态，崩溃/网络超时后禁止盲重发。同一钱包只允许一个未结束操作。

- `status` 只读对账，不开启新交易步骤。
- `resume` 使用原金额、滑点、钱包和配置，跳过已确认步骤，继续未提交的必要步骤。
- App 确认后若 BAW 历史无法通过精确 orderId 找到 txHash，继续返回待确认，不猜其他交易。
- `SUBMISSION_UNKNOWN` 且没有 orderId/txHash 时须人工核对官方记录，不自动重复 execute。
- 保留运行中的进程；结束后通过 operationId 查询，不重新运行 buy。

## 验证范围

自动测试用模拟 BAW/客户端验证提交、超时、恢复与金额逻辑。只读主网检查验证平台注册和交易构造，没有执行真实交易或用户钱包的 authenticated preview；真实风控、MPC 签名与到账仍需目标 Hermes 环境验证，不能把测试成功称作实盘成交。

## 来源

审阅日期 2026-10-25。固定依赖见 pnpm-lock.yaml，升级需核对接口。

- Binance builder：https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/scripts/agent-id-exclusive-token-launches.mjs ，原 blob `8f97c0b326963801c30398a25bc18e27f9fcf234`。本包 vendor 仅增加 `skipSimulation` 参数，用来跳过正常买卖报价后的本地试买；原 skill 标注 MIT。
- BAW references：https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet/references
- Flap 页面及公开 ABI/英文规范：https://flap.sh/apps/agent-bonding-curve?lang=zh 。组件版本 `v20261023134909522_agent-bonding-curve_8b26639fea52`，组件 SHA256 `08545080fdc1e4c8d86e827cb56a3d1f748d8369d905e29b1b1b98b374ddc83f`。
- Flap 普通 Portal：https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens
- Gang ABI：https://github.com/gangfun/cli/blob/main/src/abi.js ，原 blob `d6a2d03049beac450c8ff29fc9e51c8afd2bd45e`。
- Gang V2 算法：https://github.com/gangfun/gang-launchpad/blob/main/src/launchpad-v2/LaunchpadV2.sol ，MIT，blob `b35a2dd033e3a9d2b4fc6af87287bf7e8c119c45`。
