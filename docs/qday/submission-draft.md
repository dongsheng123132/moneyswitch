# Aevum Builder Challenge #1 提交稿（草稿 v1）

> 赛事要求：在 QDay 测试网用 tUSD8 做一个能跑通的支付流程（一份合约 + 一个简单前端或脚本 + 一段短 demo）。
> 全程线上，2026-11-16 ~ 12-11 提交，总奖金 1,500 USDT，前 5 名 12-15 路演。

## 一句话

**让 AI agent 按次付费调用 API —— 钱在 QDay 测试网上以 tUSD8 真实结算，规则写在云钱包里，收据写在链上合约里。**

## 为什么不是又一个「转账 demo」

邀请信点名看的开源项目 MoneySwitch 已经在 Monad / Base / Solana 上跑「给 AI 用的可编程云钱包」：每个 agent 一把
MoneyKey，带单笔/每日/总额度、审批线、可撤销；AI 调 HTTP API，私钥留在服务端，付款走 x402。这个提交做的是把它接上
QDay：

1. **产品侧**：QDay Aevum（chainId 44005）成为受支持网络，资产是 tUSD8。AI 用 `/v1/fetch` 调一个收费接口，
   402 → 用 tUSD8 的 EIP-712 domain 签 `TransferWithAuthorization` → 结算上链 → Bills 页出现 tx。
2. **协议侧必要件**：QDay 没有 x402 facilitator（官方 Payment SDK 说 Q1 2027 才发），所以我们自己实现了一个：
   验签、查 `authorizationState` 防重放、由 relayer 代付 tQDAY gas 上链。
3. **链上合约**：`QDayPayReceiver` —— 把 `payTo` 指向它，付款就在**同一笔交易**里完成「收 tUSD8 → 转给商户 →
   记录 orderId → emit 收据」。钱不滞留、收据和到账原子发生，并且天然给出业务层的重复付款保护位。

## 提交物清单

| 项 | 位置 | 状态 |
|---|---|---|
| 网络接入（含 domain 与链上 `DOMAIN_SEPARATOR` 的回归测试） | `packages/x402/src/networks.ts`、`packages/x402/test/qday-network.test.ts` | ✅ |
| 自建 facilitator（真结算） | `apps/qday-facilitator`（12 条离线用例） | ✅ |
| 收款合约 + Foundry 测试 + fork e2e | `contracts/`（28/28 用例，fork e2e 两次通过） | ✅ |
| **真测试网合约** | `0xb4ef0d4028770f9851051f56c0d109864f2ec83c`（tx `0x5b3e4bea…16b9`，block 2797472） | ✅ 2026-11-10 已部署 |
| 一条命令跑通的脚本（fork，不需要领水） | `packages/x402/scripts/qday-x402-fork.mjs` | ✅ L1 PASS |
| 真测试网脚本（含领水 preflight） | `packages/x402/scripts/qday-live-payment.mjs` | 待领水 |
| 真网 tx hash | — | 待收到 tUSD8 后产出 |
| demo 视频（60–90s） | `docs/qday/media/demo-l1-fork.mp4`（L1 草稿，21.5s） | 🟡 待真网 tx 后出正式版 |
| 说明文档（事实/测试分层/人要做的事） | `docs/qday/` | ✅ |

## 视频怎么产（不靠人工录屏）

`bash packages/x402/scripts/qday-capture-fork.sh` 捕获真实运行 → `render-demo-video.py` 渲染 MP4（标题卡 + 终端逐行
出现 + 结尾卡，可插入浏览器截图）。真网跑通后把 L3 的捕获喂给同一命令，并加 `--still <explorer tx 页截图>`
（`chrome --headless --virtual-time-budget=12000 --screenshot=…` 已实测可截 QDay 浏览器页面）。

## 视频脚本（60–90 秒，待录）

1. 0–10s：`node packages/x402/scripts/qday-live-payment.mjs`，镜头停在 402 报价（network=eip155:44005, asset=tUSD8）。
2. 10–25s：签名与结算过程，terminal 打印 `receipt`（含 tx hash）。
3. 25–45s：浏览器打开 `explorer-test.qday.info/tx/…`，指出 tUSD8 Transfer 事件、金额、收款方。
4. 45–65s：换成 `QDAY_RECEIVER=…` 再跑一次，浏览器指出 `PaymentReceived(orderId, …)`，说明「钱没有滞留在合约」。
5. 65–85s：一句收尾——「同一套云钱包，Monad / Base / Solana / QDay；agent 有额度，人类有审批线，链上有收据」。

## 诚实说明（会写进提交页）

- tUSD8 的 EIP-3009 nonce 只能保证「同一张授权不重复花」；业务幂等由 `QDayPayReceiver.pay(orderId, …)` 的
  `orderId` 承担，卖家不传时退化为 nonce 键。这一点和「x402 客户端重试可能产生新授权」的风险都写在
  `docs/qday/README.md §5`。
- facilitator 需要一把持有 tQDAY 的热钱包代付 gas（demo 里与 payer 同一把钥匙）；生产部署需要独立限额与告警。
- 合约源码验证：若 QDay 浏览器暂不支持，README 给出 solc 版本、优化参数、构造参数与字节码比对方法。
