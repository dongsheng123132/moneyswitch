# QDay Aevum × MoneySwitch（Aevum Builder Challenge #1）

QDay Aevum 是 QDay 的 EVM 兼容 L2 测试网（chain ID `44005`），稳定币 tUSD8 已实现 **EIP-3009**，所以 x402 的
exact-EVM 付款方式可以原样跑在它上面。这份文档记录**在链上核实过的事实**、**四层测试怎么跑**，以及**哪些环节必须人来做**。

## 1. 已核实的链上事实（2026-11-10，非二手）

| 项目 | 值 | 怎么核实的 |
|---|---|---|
| chain ID | `44005`（`0xabe5`） | `eth_chainId` → `0xabe5` |
| RPC | `https://rpc-test.qday.info` | 通，块高约 2.79M |
| 浏览器 | `https://explorer-test.qday.info` | 通，blockscout 风格 API 可用 |
| 原生币（gas） | tQDAY，18 位 | faucet → 链上 faucet 合约调用 |
| 稳定币 | tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`，6 位 | `name()`/`symbol()` 返回 tUSD8，`decimals()`=6 |
| tUSD8 结构 | 透明代理 → 实现 `0xd6be708f41b07b2f4a7b48889b8e16626e317597` | `implementation()`；实现字节码里含 `transferWithAuthorization`/`receiveWithAuthorization`/`authorizationState`/`permit` 选择器 |
| EIP-712 domain | `{name:"tUSD8", version:"2", chainId:44005, verifyingContract:tUSD8}` | 算出的 domain separator 与链上 `DOMAIN_SEPARATOR()`（`0x7838e6c4…8022`）逐字节相同；回归测试见 `packages/x402/test/qday-network.test.ts` |
| 官方 x402 facilitator | **没有** | 官方 Payment SDK 公告 Q1 2027 才发；因此本项目自带 facilitator（`apps/qday-facilitator`） |

最有力的一条证据：在本地 anvil fork（fork 的是真链状态）上跑通了一笔真实 EIP-3009 结算——payer 签名 → relayer
代付 gas 上链 → 商户余额 +12.5 tUSD8，`authorizationState(nonce)` 变 true，tx status = success。

## 2. 组件与数据流

```
AI / 脚本 ──(1) GET 收费接口──▶ demo-seller（@x402/express，报价 network=eip155:44005, asset=tUSD8）
     ▲                                    │
     └──(2) 402 + PAYMENT-REQUIRED ◀───────┘
     │
     ├──(3) 用 @x402/evm 签 TransferWithAuthorization（tUSD8 domain）
     │
     └──(4) 带 X-PAYMENT 重试 ─▶ demo-seller ──(5) /verify /settle ──▶ qday-facilitator（本项目）
                                                                          │
                                                          (6) relayer 付 tQDAY gas
                                                                          ▼
                                                   tUSD8.transferWithAuthorization(...)  → 商户
                                                   或 QDayPayReceiver.pay(...)（原子：收款+转付+订单记录）
```

- `packages/x402` 增加了一条网络配置 `QDAY_TESTNET`（`eip155:44005`）。买家侧不用改代码：启用了这条网络后，
  `client.setSpendControls` 会把 tUSD8 显式加进允许清单（它不在 SDK 的默认资产表里），`/v1/fetch` 即可付 QDay。
- `apps/qday-facilitator` 是**真结算**的 facilitator：验 EIP-3009 签名（domain 取链上事实，不信卖家报价）、
  查 `authorizationState` 防重放、由 relayer 广播并等回执。
- `apps/demo-seller` 支持 `DEMO_SELLER_NETWORK=eip155:44005`，报价直接变成 tUSD8。
- `contracts/src/QDayPayReceiver.sol`：可选的链上收款方。`payTo` 指向它时，facilitator 调它的 `pay(...)`，
  同一笔交易里完成「收 tUSD8 → 转给商户 → 记录 orderId」，并 emit 收据事件。

## 3. 四层测试（从便宜到真实）

| 层 | 命令 | 证明什么 | 需要什么 |
|---|---|---|---|
| L0 单元 | `pnpm --filter @moneyswitch/x402 test`、`pnpm --filter @moneyswitch/qday-facilitator test` | 配置事实、domain 与链上一致；facilitator 的 12 条拒绝/接受路径（离线，注入 chain reader） | 无 |
| L1 fork 端到端 | `node packages/x402/scripts/qday-x402-fork.mjs` | 完整 x402 循环在**真链状态**上跑通：402 → 签名 → 验签 → relayer 上链 → 商户到账 | anvil（自动起 fork，不需要 faucet） |
| L2 合约 | `cd contracts && ~/.foundry/bin/forge test -vv`、`bash contracts/script/e2e-fork.sh` | 收款合约语义 + 在 fork 上部署并使用 | anvil |
| L3 真测试网 | `node packages/x402/scripts/qday-live-payment.mjs` | 真链上的一笔 tUSD8 付款 + 浏览器可查的 tx | **faucet 领水（要人操作）** |

合约层（`contracts/`）已独立验证：`forge test` **28/28 通过**；`bash contracts/script/e2e-fork.sh` 在 fork 上连跑两次都过
（impersonate 真大户 → 转 0.01 tUSD8 给 payer → `cast` 签 EIP-3009 → 卖家账户代提交 `pay` → 商户 `0→10000`、
payer `10000→0`、合约 `0→0`、事件 topic1 == orderId；同 orderId 换新 nonce 重放被 `OrderAlreadyPaid` 拦住）。

把收款合约接进 x402 全链路也实测过（fork，合约 `0xDc64…6C9`）：

```
receipt.extra  : {"receiver":"0xDc64…6C9","orderId":"0x6e38…6b90", …}
payer delta    : 0.01 tUSD8 paid
merchant delta : 0.01 tUSD8
on-chain       : block 2796034, status success, logs 4
receiver       : 0xDc64…6C9 (balance 0, PaymentReceived emitted)
✔ L1 PASS
```

L1 直付（不经合约）的实测输出（2026-11-10）：

```
✔ HTTP 200 {"report":"premium content","price":"0.01"}
receipt : {"success":true,"payer":"0x3C44…93BC","transaction":"0x940897…494b3","network":"eip155:44005","amount":"10000", …}
payer delta    : 0.01 tUSD8 paid
merchant delta : 0.01 tUSD8
on-chain       : block 2795285, status success, logs 2
✔ L1 PASS
```

## 4. 必须由人做的两件事

1. **faucet 领水**（浏览器，30 秒）：
   - tQDAY（gas）：<https://faucet.qday.info> → tQDAY 标签 → 填地址领取（要求该地址在以太坊主网持有 ETH/USDT/USDC 之一，
     用于反女巫）。
   - tUSD8（付款用）：同一页 tUSD8 标签 → 用 Trellis Wallet 邮箱收验证码登录 → Claim 1 tUSD8（每 24 小时 1 枚），
     领取目标是 Trellis 主钱包，需要再从该钱包转 1 tUSD8 到演示地址。
2. **DoraHacks 报名**：<https://dorahacks.io/hackathon/qday/detail>（用你自己的账号登录报名，11-16 开放提交）。

演示地址（已生成，私钥在本机 `.data/qday-demo/demo-key.json`，**不要提交到仓库**）写在
`docs/qday/live-runbook.md` 里。

## 5. 已知风险与边界（诚实清单）

- **业务幂等**：tUSD8 的 nonce 只能防「同一张授权被花两次」。如果 HTTP 响应丢了、客户端拿新 nonce 重试，仍可能为
  同一笔业务重复付款。`QDayPayReceiver.pay(orderId, …)` 支持卖家传入自己的 `orderId` 去重；卖家不传时 facilitator
  退化成用授权 nonce 做链上键（只防重放，不防业务重试）。
- **relayer 中心化**：自建 facilitator 意味着一个需要 tQDAY 的热钱包在代付 gas。demo 里它由演示地址兼任，生产上需要
  单独的限额与告警。
- **tUSD8 有 blacklist / pause**：合约实现里有 `blacklist`/`pause` 选择器，说明发行方可以冻结地址；演示不要用会
  被风控的地址模式。
- **浏览器源码验证**：QDay 浏览器是否支持源码验证尚未实测；若不能验证，需要在 README 里给出「编译版本 + 优化参数 +
  构造参数 + 字节码比对」的自证方法（见 `contracts/README.md`）。
