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

## 2. 真测试网 tUSD8 支付（2026-11-10，三笔全部上链成功）

| # | 用途 | tx | 区块 | 结果 |
|---|---|---|---|---|
| 1 | 直接经 `QDayPayReceiver.pay()` 收款 | `0x7d606cd9fae10dd47440e36734ed9018c4d8249800e38cefc4f1cf78f1727bed` | 2797726 | status 1，4 条日志 |
| 2 | MoneySwitch `/v1/fetch` 产品级付款（第一次） | `0xe0f27c3f4a712975f17ac53910b7a9eb6c0f2013542577652fb1d6c28f664411` | 2797862 | status 1，4 条日志 |
| 3 | MoneySwitch `/v1/fetch` 产品级付款（验收跑） | `0x51f5990866fcd05f42704cd9ef4941322f3ce747b219bc108e9006bffbc50052` | 2797911 | status 1，4 条日志，key history `status=settled` |
| 4 | 产品级 demo（录制用） | `0x29b38080d09448a46475e1bd8c9e28994572492f11e4c05facb0d151da5ae17f` | — | status 1，key history `status=settled`，`amount=0.01` |

每笔交易的四条日志顺序固定：tUSD8 `AuthorizationUsed` → tUSD8 Transfer(付款方→合约) →
tUSD8 Transfer(合约→beneficiary) → `QDayPayReceiver.PaymentReceived`。**合约余额恒为 0**（钱不滞留），
收款方 `0x5C58…01aF` 余额 0.90 → **0.93 tUSD8**（三笔 0.01 全部到账）。

复核：

```bash
RPC=https://rpc-test.qday.info
TX=0x51f5990866fcd05f42704cd9ef4941322f3ce747b219bc108e9006bffbc50052
cast receipt $TX --rpc-url $RPC                     # status 1, 4 logs
cast logs --address 0xb4ef0d4028770f9851051f56c0d109864f2ec83c --from-block 2797911 --to-block 2797911 --rpc-url $RPC
```

浏览器：<https://explorer-test.qday.info/tx/0x51f5990866fcd05f42704cd9ef4941322f3ce747b219bc108e9006bffbc50052>
（截图：`docs/qday/media/live-tx.png`；视频：`docs/qday/media/demo-qday-protocol.mp4` —— 36.8 秒，含产品级 + 合约级两幕 + explorer 截图）

⚠️ 上面第 2/3/4 笔用的是**临时数据目录**里的钱包，跑完目录删掉，充进去的 tUSD8 跟着私钥一起没了（教训写在
`live-runbook.md`）。下面的 2.1 是**持久钱包**版本，也是提交里引用的那一笔。

产品级那两笔是**真的走了 MoneySwitch**：临时实例 → 生成钱包 → 发一把 per-request 上限 0.01 的 MoneyKey →
`POST /v1/fetch` → 402 → 签名 → 结算 → `/v1/history` 出现 `status=settled` + tx hash，
钱包余额 0.01 → 0。

## 2.1 真网产品级付款 —— 持久钱包、真界面（2026-11-10 22:04）

这一笔才是提交里用的"产品自己付钱"：钱包 `0x739af5…32DB` 是固定的（`.data/qday-demo/moneyswitch`），
钱是真人打进这个地址的，付款后余额还在、还能再跑。

| 项 | 值 |
|---|---|
| 充值 tx（`0x5C58…01aF` → 钱包，0.1 tUSD8） | `0x2f371aad96a1ceccf260b1e1a6bfc343a7766fcec3bc16e5b374db45277a5741`（block 2813937） |
| 付款 tx | `0xee39a716c29c14290ec064968d7e2e76e012de45ac542bae783945b0cba946cc` |
| 区块 / 结果 | 2814404 · status success · 4 条日志（`AuthorizationUsed` → 钱包→合约 → 合约→收款方 → `PaymentReceived`） |
| 付款方（只签名，不付 gas） | MoneySwitch 钱包 `0x739af5…32DB`：0.1 → 0.09 tUSD8 |
| relayer（付 gas） | `0x3252…85EbD`，本笔 gas 0.000131667 tQDAY |
| 收款合约 | `0xb4EF0d4028770f9851051f56C0D109864f2eC83c`，收完即转出，余额 0 |
| 收款方增量 | `0x5C58…01aF` +0.01 tUSD8 |
| Key 的账 | `qday-demo-agent`，`/v1/history` 首行 `status=settled`、`amount=0.01`、tx 同上 |

一条命令复现（钱包已充值；不会重建钱包）：

```bash
bash packages/x402/scripts/qday-ui-shots.sh
```

同一趟截出的产品界面（真网数据，右上角网络徽章 = `QDay Aevum testnet`）：

- `docs/qday/media/dashboard-bills-live.png` —— 账单：0.01 USDC 已付款、展开详情里有 tx 与"已确认"
- `docs/qday/media/dashboard-keys-live.png` —— Key：今日 0.01/0.05、单次上限 0.02、超 0.015 要人工批准、最近使用
- `docs/qday/media/dashboard-wallet-live.png` —— 钱包：`0x739af5…32DB` 在 QDay 上 0.09 tUSD8

视频 `docs/qday/media/demo-qday-final.mp4`（35.2 s）= 终端里的这一笔 + 上面三张界面 + explorer 同一笔交易。

只读复核：

```bash
RPC=https://rpc-test.qday.info
cast receipt 0xee39a716c29c14290ec064968d7e2e76e012de45ac542bae783945b0cba946cc --rpc-url $RPC | head -3
cast call 0x456569838f1d43009a91eba4263147afd7233483 "balanceOf(address)(uint256)" 0x739af5E56DFC7549CCa9948000A7d2dE5E7B32DB --rpc-url $RPC   # 90000 = 0.09
cast call 0xb4EF0d4028770f9851051f56C0D109864f2eC83c "beneficiary()(address)" --rpc-url $RPC                                        # 0x5C58…01aF
```

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
