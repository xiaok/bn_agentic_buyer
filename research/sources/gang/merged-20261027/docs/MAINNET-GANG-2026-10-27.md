# 主网部署记录：合并版内盘（2026-10-27）

BSC 主网（chainId 56），代码 main `eb0e027`（合约与审查通过的 `52c2eef` 相同），`script/DeployGang.s.sol` 一次运行，38 笔交易全部成功。广播记录在 `broadcast/DeployGang.s.sol/56/run-latest.json`。

| 合约 | 地址 |
|---|---|
| GangLaunchpad（内盘，税收币和打新共用） | `0x15CFD2dc8278Fb87a1783ef42111618E20874365`，部署区块 130104322 |
| GangRouter（代理，用户授权这个地址） | `0xE040445690Aa56C8b68B7f7038C7b2562B5079C4` |
| GangRouter 实现 | `0x385bab8c3040c6b41251897AC1D6622e61601c58` |
| ProxyAdmin（owner = 时间锁） | `0xddeAB7A254e42D96D5863dAeF4E89BD426017bDa` |
| TimelockController（48 小时，提案 / 执行 / 取消都只给 Safe） | `0x3911996E2F6c5636d6b1b32f75cf94d0aF4604C5` |
| GangTaxHandler（外盘税处理） | `0x6D8d3dE459629cBb7b552169a55D754db60cAe0c` |
| SharedDividendVault（外盘分红金库） | `0x1BDBDD73f51079c64BCA3917629c84c257921aCc` |
| SharedPlatformFeeBucket（内盘手续费） | `0xB8C4B68a62513240A5e44EFd78fFc35ac25bA21b` |
| SharedMigrator | `0xfE38fFce7f918cffC26575D125ed6D09864c3604` |
| TokenDeployer | `0x3A5432c562BcA145Faf21ef956C475c670d14558` |
| QuoteRegistry | `0x8b93919862830ea6A720B28C7D0C42fCbb849F17` |

- 部署钱包 `0x4EEdcDF5fab775e10C0D09951b6F59Ab81ba19d3`；owner 是 Safe `0x2866369F7acEFC9760bdE7779362fae5cD68B41E`，7 个合约已由多签批量 `acceptOwnership`（当晚链上核对 7/7）。
- keeper `0xB6f1F1BFb92476Abb0998B425dE0deC5F927cFc7`。
- 内盘手续费：80% 交给回购合约 `0x38120bf40F8F19E6cc60622Bc7C5B005dfe5363B` 回购销毁 GANG，20% 进 feeVault = Safe（部署时用 `FEE_VAULT` 覆盖了 V2 的收款钱包）。
- 白名单路由只有 GangRouter。钱包聚合器的路由按审计说明 §23.9 的清单核对后，由多签 `setRouter` 添加。
- 索引和 keeper 的起始区块用 130104251（模拟时的区块，不晚于实际部署区块）。
- 服务端 v1.2.26 / v1.2.27、网站 v1.2.34 已发布，正式站 201 已切换（备份在 `/opt/gang/backups/cutover-20261027222542`）。
- 测试网第 10 套：内盘 `0xFebF58ba418ab4a3B3f054827eb11E99369C5BB1`（区块 139236749），路由 `0x6bB660f310a9644Dc173E7Cf2F73498716D9C9F6`；完整流程 904 笔交易全部成功，含聚合器 `buyFor` / `sellFor`。
