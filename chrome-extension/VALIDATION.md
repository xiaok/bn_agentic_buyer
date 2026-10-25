# Chrome 版验证记录

日期：2026-10-25。版本：0.1.1。

## 已通过

- `pnpm build`：生成完整 Manifest V3 浏览器包，没有 Node 运行时或本地服务依赖。
- `pnpm test`：44 项通过。涵盖原交易金额、报价、授权、退款、恢复逻辑，以及 URL / Flap Market 绑定、扩展消息边界、配对码、API 字段转换和 Chrome 日志的提交前持久化。包含二维码像素解码、快捷卖出的钱包归属，以及不确定提交不能显示成功的检查。
- 0.1.1 新增：手动解锁须显式确认，完整保留原提交证据，禁止恢复和重放旧单；存储失败不放开锁，解锁与恢复互斥，超过十二条记录的待处理订单仍可见。历史查询校验官方参数、游标分页、`orderId` / `binanceTxId` 精确匹配，并在恢复时核对真实调用而非误认授权哈希。
- 独立 Chrome 模拟订单回归：取消解锁确认时仍保持锁，确认后买卖按钮恢复，解锁本身不产生任何网络请求；刷新后状态保留，恢复旧单被拒绝，新操作能创建。证据：`evidence/force-unlock-validation.json`、`force-unlock-before.png`、`force-unlock-after.png`。没有访问真实钱包或发出真实交易。
- 独立 Chrome 配置中的模拟初始化：生成六位配对码、轮询确认、读取钱包地址和 Developer Mode、保存并复用会话。页面重新打开不会重复登录。
- 扫码界面回归：实际 Chrome canvas 像素可解码为原始登录链接；待扫码时重开页面恢复原二维码，不重复登录；过期后隐藏二维码并提示重连；模拟连接成功后隐藏配对区。证据：`evidence/pairing-qr-validation.json`、`pairing-qr.png`（模拟二维码）。
- 浏览器点击回归：真实鼠标点击触发一次操作，脚本合成 click 被忽略，双击不会创建两个进行中的操作，同一 UUID 重放不会生成新订单。Flap 卡片按其精确 Market key 创建操作。模拟 RPC 在任何授权 / preview / execute 前停止。
- 新交互 Chrome 回归：网页显示买入失败 / 成功提示与交易链接；订单页按该行地址请求卖出 50% / 全部，即使输入框是另一个地址；双击只生成一笔操作，进行中禁用其他卖出按钮；网页面板和订单页的平台链接均正确。全部为模拟订单，证据：`evidence/feedback-validation.json`、`buy-success-notice.png`、`order-quick-sell.png`。
- 使用本地 HTTPS 服务与实际 Chrome 网络栈验证 Cookie：捕获 Set-Cookie、只给扩展自己的下一次 API 请求注入该会话、浏览器普通 Cookie jar 保持不变。没有请求 Binance。
- 三个真实公开网站的只读页面检查：Four preset 列表、Flap 卡片与详情、Gang 列表均出现按钮，所显示地址与对应 token / Market 一致。此检查的钱包网络请求被阻断，显示的是测试会话外观。
- 原 agent 目录与交付前保存的 SHA256 清单一致，与此前交付 `dist/agent-trade.zip` 的对应文件逐字节相同。旧 ZIP 的 SHA256：`27562dc0a49c90a431d96b58450c9fd68921947187246d1033dfd88e62203037`。

证据在源码项目的 `evidence/browser-validation.json`、`cookie-validation.json`、`live-page-bindings.json`、`engine-readonly.json` 及页面截图中。页面条目和数量会随网站更新变化，截图不是行情承诺。

## 用户环境中的真实买入

用户自行连接钱包并点击买入后，扩展订单显示 `SUCCESS`。仅通过公开 BSC RPC 只读核对：交易 `0xe76487700199102525e77c721fd7cefe892e2b9846d65cc9409d575f08a0c7bb` 回执 `status=0x1`，区块 129712829；`ptah` token `0x47e19d4502Bd19A01537C0D807736b2707d9FfFF` 有转入该钱包的 Transfer 日志，数量为 22754.359017658864206222，查询时余额相同。订单预算为用户设定的 0.0001 BNB。该检查没有代用户发送任何交易。

## 尚未验证

上述一笔交易不能覆盖三个平台的全部内盘 / 外盘、卖出、资金兑换、断线恢复或 App 风控分支；这些仍未全面实盘验证。此次新增的快捷卖出与提示使用模拟订单测试，没有额外真实下单。Binance CLI 的 HTTP 协议移植尚不是官方浏览器 SDK；服务端可能因客户端、接口变化、地区或账号设置拒绝请求。

原 agent 文件保持不变，不代表两个独立客户端在同一钱包上并发下单具有共享的本地锁；这两个版本不共享操作日志。

默认配置为 0.001 BNB、交易 / 资金兑换各 100 bps 滑点，链上 gas 另计。跳过额外本地试买，保留 BAW preview。
