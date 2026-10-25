# LaunchpadV2 主网地址（REFPOOL · any pair · ≈15 BNB）

- 时间：2026-10-23 19:13:35 Asia/Shanghai
- OWNER：`0x4EEdcDF5fab775e10C0D09951b6F59Ab81ba19d3`
- startBlock（LaunchpadV2 CREATE）：`129311617`
- createTx：`0xcf0cb50e4c86096eb370600219dafd69d43220ef102eff01eff6032d1b784d7e`
- 口径：any pair + REFPOOL；毕业 ≈15 BNB 等值；BAW + 1% walletCap；分红门槛 10_000；复用 Burner/feeVault/GANG
- **未改** Soft `0x4E6f…80d7` / U `0xF81C…712cb` / S `0x60ae…430C1`
- 体积修复：PoolCheck → public library `0xd2B159820749f178503E4faBCB18A7Ae4492bDb3`（pad bytecode 24182 < 24576）

## 新部署

| 合约 | 地址 |
|---|---|
| LaunchpadV2 | `0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E` |
| MigratorV2 | `0x2D54351657647824c92a36c309A8ed40715968F6` |
| QuoteRegistry | `0x053C2868e54921afEd7742bbb4c4fDA99a12060D` |
| DividendVault (minShare 10_000) | `0x5e2Dd1D439b251d64B4147D8947445f83f3A2D62` |
| PlatformFeeBucket | `0xBDDd8F275D7Cb65f5454D0bEDf0463792878F111` |
| PostGradTaxHandler | `0xa2bd8e511Cf01aA8F9693a841FD6ee6E30253e29` |
| PoolCheck (library) | `0xd2B159820749f178503E4faBCB18A7Ae4492bDb3` |

## 复用（现网）

| 合约 | 地址 |
|---|---|
| BuybackBurner | `0x2aC14C462901F990ae7647D6AcafEaf50Cc8f8dF` |
| feeVault | `0x3464aa1097Aa46502Db847E4c6d0A2D52a871Af4` |
| GANG | `0x0c6302401aa5325C2E36F170f52C00B1d220B405` |

## 链上自检

- agentGate=true · walletCap=true · TARGET_GRAD_BNB=15e18
- USDT bridge = `0x36696169C63e42cd08ce11f5deeBbCeBae652050`
- bucket.burner / feeVault = 现网复用
- Soft/U/S owner 仍为 `0x4EEd…`（未碰）
