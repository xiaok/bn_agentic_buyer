# Agent Trade 交付验证

验证日期：2026-10-25。默认买入 0.001 BNB，内盘滑点 100 bps，资金兑换滑点 100 bps。

- 22 项自动测试全部通过：金额精度、滑点、Probe 解码、Gang 曲线和退款、只处理本次到账、Flap shares/claim/六位精度、必要授权、超时不重复提交、App 订单精确恢复、阶段变化、Developer Mode 与身份检查。
- 测试明确验证正常订单只有 BAW preview/execute，没有额外本地试买 eth_call。
- 主网只读：Four 示例地址和 Flap 示例地址均能以 0.001 BNB 构造买入；Gang V2 示例能读取平台注册、内盘状态和 GANG 报价币。
- Flap 待确认 claim 遇市场迁移的恢复边界已修复并覆盖：先对账原提交，再停止不适用的后续计划。
- Skill 格式校验通过；交付包在临时目录重新安装固定依赖，并运行 CLI 与全量测试检查可复制性。

## 实盘验证边界

没有调用真实钱包的 login、preview、execute、approve 或 swap。自动测试使用模拟钱包和客户端，主网检查只读。目标 Hermes 环境的 BAW 会话、Developer Mode、App 风控、MPC 签名和真实成交耗时尚未验证。

此前 Flap 0.01 BNB 的 0.752 秒中位数仅为只读准备耗时；不能作为 0.001 BNB 下单成交时间。详见 FLAP-BENCHMARK.md。

## 使用

解压包中的 agent-trade 目录到 Hermes skills 目录，在该目录运行一次：

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

之后向 Hermes 发出 `agent buy <address>` 即按默认 0.001 BNB 执行；显式金额覆盖默认值。已有 baw 会话会直接复用，缺少会话才配对。Binance 强制 preview 与 App 确认仍保留。
