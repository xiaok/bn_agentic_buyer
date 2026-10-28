# Gang 合并 Pad 适配与验证

日期：2026-10-28。适用版本：Chrome 0.1.3。原 agent CLI / skill 0.1.0 和原安装包保持不变。

## 问题与修复

`0x378afee1ce6c88f0fdc568518140b9a0ab794da5`（BOLT）属于 2026-10-27 部署的合并 Pad，旧扩展没有登记该地址；同时旧 S 分支实际返回 9 字段，而原适配按 10 字段解码，最终误报平台查询失败。

- 新 Pad：`0x15CFD2dc8278Fb87a1783ef42111618E20874365`。
- 官方 Router：`0xE040445690Aa56C8b68B7f7038C7b2562B5079C4`。
- 识别核对 `kindOf`、曲线登记及 token 的 `launchpad()`；交易前核对 Pad / Router / WBNB 绑定与曲线常数。`kind=1` 为 V3，`kind=2` 为 fair mint，后者明确拒绝，不套用 V3 报价。
- WBNB 报价且 Router 可用时，直接调用 `v3BuyBNB`，省去预先 wrap / 授权；否则保留精确 ERC20 兑换和授权路径。内盘卖出直接授权并调用 Pad，所得 WBNB 解包为 BNB。新版内盘只收 1% protocol fee，曲线字段中的买卖税用于毕业后，不用于内盘报价。
- 达到持仓上限 / 毕业时，Pad 将原生买入的退款直接发给用户，资产是 WBNB。仅解包本笔已核验回执的净转入量，不动已有余额；退款待 App 确认后恢复原步骤，不重复买入。
- 旧 S 使用正确的 9 字段 ABI，0.5% + 0.5% 手续费各自向下取整。

## 来源

官方仓库固定版本：[`gangfun/gang-launchpad@7d6dfd3`](https://github.com/gangfun/gang-launchpad/tree/7d6dfd318d6a15c65563c3d1b0e099ef57bdf123)。选用该仓库的新部署说明及合约，而非仍描述旧部署的独立 `gangfun/cli` 快照。来源快照与 SHA256 保存在 `sources/gang/merged-20261027/`。

- [部署说明](https://github.com/gangfun/gang-launchpad/blob/7d6dfd318d6a15c65563c3d1b0e099ef57bdf123/docs/MAINNET-GANG-2026-10-27.md)
- [CurveLogic](https://github.com/gangfun/gang-launchpad/blob/7d6dfd318d6a15c65563c3d1b0e099ef57bdf123/src/gang/CurveLogic.sol)
- [GangRouter](https://github.com/gangfun/gang-launchpad/blob/7d6dfd318d6a15c65563c3d1b0e099ef57bdf123/src/router/GangRouter.sol)
- [旧 S](https://github.com/gangfun/gang-launchpad/blob/7d6dfd318d6a15c65563c3d1b0e099ef57bdf123/src/stocks/LaunchpadS.sol)

## 验证边界

Chrome 58 项测试全部通过，新增 8 项覆盖识别与错误绑定、S 解码 / 手续费、原生买入、50% 卖出、退款中断恢复及 ERC20 回退。交易测试使用模拟钱包，不提交资金。

主网只读证据位于 `../chrome-extension/evidence/gang-merged-mainnet-readonly.json`：区块 130262268，链 ID 56，BOLT 仍在内盘；公开参考钱包满足 Agent 身份及钱包上限，0.001 BNB 交易参数指向官方 Router、无额外授权。`cast call` 成功返回非零代币数量。行情会变化，此记录不是后续时点的成交保证。

此次没有访问真实 Binance 会话、签名或广播交易，没有新增实盘买卖。开发时的 `eth_call` 不加入真实下单路径；真实交易仍仅走原有必要的 BAW preview / execute。新版 fair mint 暂不支持，毕业后的市场单沿用现有 BAW 外盘路径。
