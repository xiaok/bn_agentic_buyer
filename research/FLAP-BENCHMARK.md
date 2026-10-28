# Flap 0.01 BNB 买入只读测速

实测日期：2026-10-25，Asia/Tokyo。地址：`0xfC0f0592eDCC6E96efb5Fb5E9CA48db3fb757777`。

买入预算 0.01 BNB，模拟假设滑点 100 bps（1%）。没有修改用户交易配置，没有连接、签名、广播或实际支付。

## 结果

7 次全部通过资格检查、报价和精确 Portal.buy 的 eth_call；每轮固定一个新鲜区块，范围为 129698405–129698414。

| 指标 | 时间 |
| --- | --- |
| 完整准备路径中位数 | 0.752 秒 |
| 最快 | 0.697 秒 |
| 最慢 | 0.953 秒 |
| 输入地址反查 Market，中位数 | 0.149 秒 |
| Probe/Registry 解析和校验，中位数 | 0.152 秒 |
| 资产绑定、资格、余额校验，中位数 | 0.162 秒 |
| 报价及交易计划，中位数 | 0.144 秒 |
| 精确买入 eth_call，中位数 | 0.136 秒 |

各阶段的中位数之和不要求等于整轮中位数。

发送人使用该市场已公开的历史交易地址 `PUBLIC_REFERENCE_ACCOUNT`，仅作为 eth_call 的 from。它有 Agent ID 和足够 BNB；这不是用户的钱包，不代表用户自己的资格和余额已验证。没有覆盖或伪造余额、身份或合约状态。

当前市场是原生 BNB 内盘，不需换币和 ERC20 授权。模拟成功返回的是内部 shares，未发生实际到账。

最近额外抽样的 128 个区块跨度 57 秒，平均约 0.445 秒/块。这个周期不等于广播后成交耗时，也不证明某笔交易能进入下一个块。

## 测量范围

每轮重新执行：Factory.marketOfToken → Factory/Portal 绑定查询 → Probe.market/asset/status/capacity + 余额 → buyPlan/quoteBuy → 精确 Portal.buy 模拟。依赖步骤顺序执行，独立读取并行，包含 cast 子进程启动开销。使用单个 Flap 适配路径，并未实现或测量完整三平台 CLI。

**不包含** Binance BAW 的认证、后端 preview/风险检查、MPC 签名、App 确认、交易广播、打包、receipt 轮询。当前 PATH 没有 baw 可执行程序，也没有用户会话，因此不能报告真实完整买入耗时。

后续可测的总耗时关系：

```text
买入总耗时 = 本地准备/模拟 + BAW 风控与签名 + 广播及上链 + 结果确认
首次使用额外包含安装/配对及必要的 App 设置时间
```

不能用 gas 数量或 eth_call 的执行时间代替链上成交时间。首次使用的人工配对时间也无法由只读模拟预测。

## 复现

```bash
python3 scripts/benchmark_flap_buy.py \
  0xfC0f0592eDCC6E96efb5Fb5E9CA48db3fb757777 \
  --from "$PUBLIC_REFERENCE_ACCOUNT" \
  --bnb 0.01 --slippage-bps 100 --runs 7
```

脚本仅调用 cast 的只读功能，不持有私钥。原始逐轮时间和返回数据见 `flap-buy-benchmark.json`。小样本、单个公共 RPC 的当前结果，不代表其他机器、RPC、未来负载或跨资产兑换路径。
