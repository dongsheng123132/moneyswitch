# 证据台账（真链上可核验的部分）

所有条目都能用命令行或浏览器独立复核；下面的命令都是只读的。

## 1. 真测试网合约（2026-11-10 部署）

| 项 | 值 |
|---|---|
| 合约 | `QDayPayReceiver` = `0xb4ef0d4028770f9851051f56c0d109864f2ec83c` |
| 部署 tx | `0x5b3e4bea2a6b2119a169cd881a294728b6dd5578eea6e0f02653d98c329e16b9` |
| 区块 | 2797472（status = 1，logs = 2） |
| 部署者 / owner | `0x3252DE0a8104d70e4BB63e0C61109f1180e85EbD` |
| beneficiary（收款方） | `0x5C5869bceB4C4eb3fA1DCDEeBd84e9890DbC01aF` |
| runtime 字节码 | **2937 bytes**（与 `forge inspect QDayPayReceiver deployedBytecode` 一致） |

复核：

```bash
RPC=https://rpc-test.qday.info
C=0xb4ef0d4028770f9851051f56c0d109864f2ec83c
cast code $C --rpc-url $RPC | wc -c                      # 字节码非空
cast call $C "owner()(address)" --rpc-url $RPC           # 0x3252…85EbD
cast call $C "beneficiary()(address)" --rpc-url $RPC     # 0x5C58…01aF
cast call $C "token()(address)" --rpc-url $RPC           # tUSD8 0x456569838f1d43009A91ebA4263147Afd7233483
cast receipt 0x5b3e4bea2a6b2119a169cd881a294728b6dd5578eea6e0f02653d98c329e16b9 --rpc-url $RPC | head -5
```

浏览器：<https://explorer-test.qday.info/address/0xb4ef0d4028770f9851051f56c0d109864f2ec83c>
（截图：`docs/qday/media/live-contract.png`）

## 2. 真测试网 tUSD8 支付

待第一笔真网付款跑通后填入：

| 项 | 值 |
|---|---|
| tx | _待填_ |
| 金额 | 0.01 tUSD8（10000 原子单位） |
| payer | _待填_ |
| 商户到账 | _待填_ |
| receiver 合约余额 | 0（钱不滞留） |
| `PaymentReceived(orderId,…)` | _待填_ |

## 3. fork 上的完整链路（不需要任何测试币，任何人可复现）

```bash
bash packages/x402/scripts/qday-capture-fork.sh
```

输出（2026-11-10 实测）：payer −0.01、merchant +0.01、receiver 余额 0、`PaymentReceived` 已 emit，
`✔ L1 PASS`。捕获文本见 `docs/qday/media/l1-fork-capture.txt`，渲染出的视频见 `docs/qday/media/demo-l1-fork.mp4`。

## 4. 测试与构建

| 层 | 命令 | 结果 |
|---|---|---|
| 合约 | `cd contracts && forge test --offline` | 28 passed / 0 failed |
| 网络配置 | `pnpm --filter @moneyswitch/x402 test` | 146 passed（含 domain 与链上 `DOMAIN_SEPARATOR` 的钉死断言） |
| facilitator | `pnpm --filter @moneyswitch/qday-facilitator test` | 12 passed |
| 全仓 | `pnpm build && pnpm test && pnpm test:e2e` | build 12/12 包、unit 1244、e2e 144，0 failed |
