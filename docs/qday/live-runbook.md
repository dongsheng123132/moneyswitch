# L3 真测试网跑通手册（需要人操作的地方标 👤）

演示钱包（本机生成，测试网专用、无价值；私钥在 `.data/qday-demo/demo-key.json`，`.data/` 已 gitignore）：

| 角色 | 地址 | 需要什么 |
|---|---|---|
| payer（也是 relayer） | `0x3252DE0a8104d70e4BB63e0C61109f1180e85EbD` | tQDAY（gas）+ ≥0.01 tUSD8（付款） |
| merchant（收款） | `0x2865278B5b627BC3A077CF95243394683A69348b` | 不需要任何东西 |

## 第 0 步 👤 领水（浏览器，约 30 秒）

1. 打开 <https://faucet.qday.info>，切到 **tQDAY** 标签，粘贴上面的 payer 地址领取。
   - 该 faucet 要求「接收地址在以太坊主网持有 ETH/USDT/USDC 之一」，用于反女巫；不满足会报不可用。
2. 同一页切到 **tUSD8** 标签，用 **Trellis Wallet 邮箱**收 8 位验证码登录，Claim **1 tUSD8**（每 24 小时 1 枚）。
   - 领取进的是 Trellis 主钱包；再从该钱包把这 1 tUSD8 转给上面的 payer 地址（Trellis 的转账页）。
3. 验证到账（不需要我，你自己就能看）：

```bash
cast call 0x456569838f1d43009A91ebA4263147Afd7233483 "balanceOf(address)(uint256)" 0x3252DE0a8104d70e4BB63e0C61109f1180e85EbD --rpc-url https://rpc-test.qday.info
cast balance 0x3252DE0a8104d70e4BB63e0C61109f1180e85EbD --rpc-url https://rpc-test.qday.info
```

### faucet 的实际情况（2026-11-10 从页面配置读出来的）

| tab | 怎么领 | 门槛 |
|---|---|---|
| **tQDAY** | 填地址 + Cloudflare Turnstile 人机验证，faucet 合约 `0x33d19Bde2e1798c13808f17BfBa1780b28e4bACC` 代发 | 5 tQDAY / 地址 / 24h；**要求该地址在以太坊主网持有 ETH/USDT/USDC 之一**（反女巫） |
| **tUSD8** | Trellis 账号邮箱 + 8 位验证码登录，只能发到 Trellis 主钱包 | 1 tUSD8 / 24h；领完要从 Trellis 转到演示地址 |
| Airdrop | 页面配置里 `NEXT_PUBLIC_AIRDROP_ENABLED=false`，**已关闭** | — |

也就是说 tQDAY 只要地址 + 点一次人机验证；tUSD8 必须注册 Trellis。**如果 tQDAY 提示地址不合格**（主网持仓门槛），
最省事的是让主办方直接打币（邮件草稿在会话里，一句话就能发）：0.05 tUSD8 + 少量 tQDAY 到演示地址。

## 一条命令跑完全部（领水之后）

```bash
bash packages/x402/scripts/qday-run-all.sh
```

它做四件事：部署 `QDayPayReceiver` 到真网（已部署过就复用）→ 跑一笔真 tUSD8 支付 → headless Chrome 截真网 tx 页 →
渲染 `docs/qday/media/demo-qday-live.mp4`（含终端过程 + 浏览器截图）。任何一步缺钱都会在 preflight 直接说清楚缺什么。

## 第 1 步 M1：真网直付（不需要合约）

```bash
cd ~/code/族-research/1mineyswitch
node packages/x402/scripts/qday-live-payment.mjs
```

跑通的标准：末尾打印 `✔ L3 PASS`，给出 `https://explorer-test.qday.info/tx/0x…`，商户 tUSD8 +0.01。

## 第 2 步 M2：经收款合约（原子收据）

```bash
# 2.1 部署 QDayPayReceiver（owner 与 relayer 同一把钥匙；beneficiary = merchant 地址）
cd contracts
PRIVATE_KEY=$(python3 -c "import json;print(json.load(open('../.data/qday-demo/demo-key.json'))['payerAndRelayer']['privateKey'])") \
  ~/.foundry/bin/forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc-test.qday.info --broadcast --private-key "$PRIVATE_KEY"
# 记下输出的合约地址 RECEIVER=0x…

# 2.2 让 payTo 指向合约
cd ..
QDAY_RECEIVER=$RECEIVER node packages/x402/scripts/qday-live-payment.mjs
```

跑通的标准：`receipt.extra` 里带 `receiver` 与 `orderId`，商户 +0.01，合约余额为 0（钱没有滞留），
浏览器里能看到 `PaymentReceived` 事件。

## 第 3 步 录 demo（60–90 秒）

一条命令能跑完全流程，录屏只需要录：终端打印（402 → 签名 → 结算）＋ 浏览器打开 tx 页。

## 👤 DoraHacks 报名（11-16 起可提交）

<https://dorahacks.io/hackathon/qday/detail> → 用你自己账号报名 → 提交时填：
- 项目名：**MoneySwitch × QDay：给 AI agent 用的 tUSD8 按次付款钱包**
- 仓库：本分支 `feat/qday-aevum-testnet`（推 fork/公开仓后给出链接）
- 合约地址、L3 的 tx hash、demo 视频链接
