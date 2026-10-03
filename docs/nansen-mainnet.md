# 用真实 Monad 主网 USDC 调用 Nansen x402 API / Real Monad mainnet run against Nansen's x402 API

⚠️ **这条路径会花真实的美元（USDC）。** 全程用独立的数据目录，不要复用测试网钱包。
⚠️ **This path spends REAL money (USDC).** Use a separate data directory; never reuse the testnet wallet.

已验证的事实（2026-09-27）/ Verified facts:
- Nansen `POST https://api.nansen.ai/api/v1/token-screener` 的 402 响应里
  `accepts` 为 `{scheme:"exact", network:"eip155:143", asset:"0x754704Bc059F8C67012fEd69BC8A327a5aafb603" (USDC), amount:"10000"（$0.01）, extra:{name:"USDC",version:"2"}}`，
  facilitator 是 Molandak（和我们自己用的一样）。
- Monad 主网 RPC `https://rpc.monad.xyz`，chainId `0x8f` = 143。
- Gas 由 facilitator 代付：Agent 金库不需要持有 MON，只需要 USDC（见 `docs/pitch/deck-brief.md`）。

## 1. 独立数据目录 / separate data dir

```bash
export MONEYSWITCH_DATA_DIR=.data/mainnet
export MONEYSWITCH_MAINNET_ENABLED=true
```

`MONEYSWITCH_DATA_DIR` 必须和测试网/本地演示用的目录不同，这样主网钱包和测试网钱包是两把完全独立的 keystore，
不会串用（见 `packages/x402/src/networks.ts` 的 `MAINNET`/`TESTNET` 配置）。

## 2. 启动 server / start the server

```bash
pnpm build
MONEYSWITCH_DATA_DIR=.data/mainnet MONEYSWITCH_MAINNET_ENABLED=true MONEYSWITCH_PORT=4020 \
  node apps/server/dist/index.js
```

（如果 Nansen/RPC/facilitator 这些出站请求因为在代理后面而超时，server 会自动
跟随 Clash/v2rayN 之类的代理——选择顺序见 README「自己的服务器」一节，无需额外配置。）

启动时会打印一条醒目的一次性警告（`WARNING: ... REAL USDC on Monad mainnet ...`）。如果
`MONEYSWITCH_MAINNET_ENABLED=true` 但 mainnet 的 `rpcUrl` 被显式清空，server 会拒绝启动并报错，
不会带着一个没有 RPC 的主网配置静默跑起来。

首次启动会打印一次性的登录链接（`http://127.0.0.1:4020/login#ms_setup_...`），用它登录 Dashboard，在「钱包」页创建钱包，
参考 `docs/quickstart.md` 第 3 节。**这一步创建的钱包是全新的，余额为 0**，需要人工转入真实 USDC（见第 4 步）。

## 3. 创建限额 MoneyKey / create a rate-limited MoneyKey

```bash
curl -X POST http://127.0.0.1:4020/v1/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "nansen-agent",
    "total_budget": "1.00",
    "daily_budget": "0.50",
    "per_request_limit": "0.05",
    "allowed_hosts": ["api.nansen.ai"]
  }'
```

响应里的 `mk_live_xxx` 只显示这一次，存好。限额建议：单次 ≤ $0.05、每日 ≤ $0.50、总额 ≤ $1.00
——Nansen 这个 endpoint 单价是 $0.01，够跑不少次调用，同时把误操作的最大损失锁在 $1 以内。

## 4. 人工充值金库 / manually fund the vault (human step, not automated)

把 ~1–2 USDC（Monad 主网上的 USDC 合约地址 `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`）转到
`GET /v1/admin/meta` 返回的 `wallet_address`。**这一步必须人工完成**——本仓库任何脚本都不会自动充值。
金库不需要 MON：gas 由 facilitator（Molandak）代付。

## 5. 调用 Nansen / call Nansen

```bash
MONEYSWITCH_URL=http://127.0.0.1:4020 MONEYKEY=mk_live_xxx pnpm nansen:mainnet
```

先用 `--dry` 确认会发出的请求，不会真的调用：

```bash
MONEYSWITCH_URL=http://127.0.0.1:4020 MONEYKEY=mk_live_xxx node scripts/nansen-mainnet.mjs --dry
```

其他可选参数：`--endpoint token-screener`（默认）、`--chains monad`（默认）、`--timeframe 24h`（默认）。
脚本只打印状态、payment（金额 + tx hash + `https://monadvision.com/tx/<hash>` 浏览器链接）、
剩余额度，以及从响应体 `data` 数组里挑出的前 5 条 token 摘要，从不打印 MoneyKey 本身。

---

## English summary

1. Separate data dir: `MONEYSWITCH_DATA_DIR=.data/mainnet`, `MONEYSWITCH_MAINNET_ENABLED=true` — never
   reuses the testnet wallet/keystore.
2. Start the server with those two env vars (`node apps/server/dist/index.js`, same as `docs/quickstart.md`
   step 4). It logs a loud one-time mainnet warning, and refuses to start if the mainnet RPC URL is
   explicitly emptied.
3. Create a MoneyKey scoped to `api.nansen.ai` with tight limits (per-request $0.05, daily $0.50,
   total $1.00 suggested).
4. **Manually** send ~1–2 real USDC (Monad mainnet USDC contract
   `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`) to the wallet address from `GET /v1/admin/meta`. No MON
   needed — the facilitator (Molandak) pays gas.
5. Run `pnpm nansen:mainnet` (or `node scripts/nansen-mainnet.mjs --dry` first to preview the request).
