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

## 产品级 demo 用的持久钱包（已充值，2026-11-10）

产品级那一支（`qday-ui-shots.sh` / `qday-product-demo.mjs`）用的不是上面这两个地址，而是 MoneySwitch 自己的钱包：

| 项 | 值 |
|---|---|
| 地址 | `0x739af5E56DFC7549CCa9948000A7d2dE5E7B32DB`（数据目录 `.data/qday-demo/moneyswitch`，**别删这个目录**） |
| tUSD8 | 0.1（2026-11-10 由 `0x5C58…01aF` 转入，tx `0x2f371aad96a1ceccf260b1e1a6bfc343a7766fcec3bc16e5b374db45277a5741`） |
| tQDAY | 不需要——买家只签 EIP-3009，gas 由 relayer `0x3252…85EbD` 付 |
| 助记词 | 已抄到 `.data/qday-demo/recovery-phrase-0x739af5….txt`（`.data/` 已 gitignore），并已在产品里确认备份，所以钱包页会显示地址和余额 |
| admin token | 只在该目录**第一次**启动时打印；之后再启动请用 `node scripts/admin-reset-token.mjs --data-dir .data/qday-demo/moneyswitch` 轮换一把（脚本里已自动处理，且不会写进任何提交文件） |

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

## 血的教训：钱包数据目录必须持久

第一次跑产品级 demo 时用了 `mktemp -d` 做 MoneySwitch 数据目录，跑完目录被删——**钱包私钥跟着没了，充进去的
0.02 tUSD8 就永久锁死**（本次实测丢了两笔 0.02，测试网无价值但流程是错的）。现在两个脚本都改用持久目录
`.data/qday-demo/moneyswitch`，并且**复用同一个钱包**、只在余额不足时才充：

```bash
# 当前这台持久钱包（也可以直接把 tUSD8 打进这个地址，省一次转账）
cat .data/qday-demo/moneyswitch-wallet.json
# {"address":"0x739af5E56DFC7549CCa9948000A7d2dE5E7B32DB", ...}
```

## 第 3 步 出界面证据 + 录 demo

```bash
# 真网：付款 + 同一趟截图（dashboard 账单/Key/钱包），并把终端记录写进 live-product-capture.txt
bash packages/x402/scripts/qday-ui-shots.sh
# 只想重拍界面、不再花钱：
QDAY_SKIP_PAYMENT=1 bash packages/x402/scripts/qday-ui-shots.sh
# 渲染视频（终端实测 + 三张界面 + explorer 交易页）
python3 packages/x402/scripts/render-demo-video.py --input docs/qday/media/live-product-capture.txt \
  --title "MoneySwitch × QDay Aevum — 让 AI 按次付费，真网 tUSD8" \
  --subtitle "真测试网（chainId 44005）· 产品级 /v1/fetch · EIP-3009 结算 · 仪表盘与链上收据" \
  --endcard "tx 0xee39a7…46cc · 钱包 0.1 → 0.09 tUSD8 · 收款方 +0.01 · 收款合约余额 0" \
  --still docs/qday/media/dashboard-bills-live.png  --still-caption "dashboard · 账单：这笔支出带链上 tx 与「已确认」" \
  --still docs/qday/media/dashboard-keys-live.png   --still-caption "dashboard · Key：今日 0.01/0.05 · 单次上限 0.02" \
  --still docs/qday/media/dashboard-wallet-live.png --still-caption "dashboard · 钱包：QDay Aevum 测试网 0.09 tUSD8" \
  --still docs/qday/media/live-tx-product.png       --still-caption "explorer-test.qday.info · 钱包 → 收款合约 → 收款方" \
  --line-hold 0.55 --still-hold 4.5 --out docs/qday/media/demo-qday-final.mp4
```

完整命令（含每张截图的说明文字）在 `docs/qday/README.md §3.5`。

## 👤 DoraHacks 报名（11-16 起可提交）

<https://dorahacks.io/hackathon/qday/detail> → 用你自己账号报名 → 提交时填：
- 项目名：**MoneySwitch × QDay：给 AI agent 用的 tUSD8 按次付款钱包**
- 仓库：本分支 `feat/qday-aevum-testnet`（推 fork/公开仓后给出链接）
- 合约地址、L3 的 tx hash、demo 视频链接
