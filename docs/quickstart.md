# Quickstart

This walks through running MoneySwitch + the demo-seller locally (no
Docker required — Docker daemon is not assumed to be running).

## 0. Fastest path: one-command local demo

```bash
pnpm install
pnpm build
pnpm demo:local
```

This starts mock-facilitator (4099), demo-seller (4021, pointed at the
mock facilitator — no real payment ever happens) and the server (4020,
also serving the Dashboard UI at `/`) together, with data under the
repo-local `.data/local/` directory (gitignored). Press Ctrl+C to stop all
three. The admin token is printed exactly once, into
`.data/local/server.log` (only on the first boot of a fresh data dir).
`MONEYSWITCH_WALLET_PASSWORD` defaults to `demo-password` if unset — fine
for this offline demo, never for anything with real funds.

Once it's up, open `http://127.0.0.1:4020/` for the Dashboard, or follow
steps 5–7 below (against the already-running services) to drive it via
curl / MCP instead.

For a real Monad testnet run (no mock, real facilitator, needs a funded
wallet — see step 5), use `DEMO_SELLER_PAY_TO=0xYourAddress pnpm
demo:testnet` instead; see `docs/demo.md` for details. It does not auto-fund
or auto-pay anything.

The rest of this document walks through the same steps manually, useful if
you want to run each piece with your own ports/config.

## 1. Install and build

```bash
pnpm install
pnpm build
```

## 2. Start the mock facilitator (for local demo without a real facilitator)

```bash
MOCK_FACILITATOR_PORT=4099 node packages/mock-facilitator/dist/server.js
```

Or point `demo-seller` at the real Monad testnet facilitator
(`https://x402-facilitator.molandak.org`, the default) instead — no flag
needed in that case.

## 3. Start demo-seller

```bash
DEMO_SELLER_PORT=4021 \
DEMO_SELLER_PAY_TO=0xYourDemoSellerAddress \
DEMO_SELLER_FACILITATOR_URL=http://127.0.0.1:4099 \
node apps/demo-seller/dist/index.js
```

`DEMO_SELLER_PAY_TO` must NOT equal the MoneySwitch wallet address you
create in step 4.

## 4. Start the MoneySwitch server

```bash
MONEYSWITCH_DATA_DIR=~/.moneyswitch MONEYSWITCH_PORT=4020 node apps/server/dist/index.js
```

On first run this prints an admin token to stdout **exactly once**:

```
[moneyswitch] Admin token (save this now, it will not be shown again):
  ms_admin_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Save it — it is stored only as a hash, and cannot be recovered.

## 5. Create a wallet and unlock it

```bash
curl -X POST http://127.0.0.1:4020/v1/admin/wallet/create \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"password":"a strong password"}'

curl -X POST http://127.0.0.1:4020/v1/admin/wallet/unlock \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"password":"a strong password"}'
```

Or set `MONEYSWITCH_WALLET_PASSWORD` (or `_FILE`) before starting the
server to auto-unlock on boot.

The wallet is brand new and has 0 USDC until you fund it (see
`docs/security.md` — never fund it with more than you're prepared to lose
to a bug in v0.1).

## 6. Create a MoneyKey

```bash
curl -X POST http://127.0.0.1:4020/v1/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "total_budget": "10",
    "daily_budget": "5",
    "per_request_limit": "1",
    "approval_threshold": "0.10",
    "allowed_hosts": ["127.0.0.1:4021"]
  }'
```

The response includes the full `mk_live_xxx` key **only this once** — save it.

## 7. Call a priced endpoint through MoneySwitch

```bash
curl -X POST http://127.0.0.1:4020/v1/fetch \
  -H "Authorization: Bearer $MONEY_KEY" -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1:4021/premium-report"}'
```

## 8. Use it from Claude Code / Codex via MCP

See [`docs/claude.md`](claude.md) and [`docs/codex.md`](codex.md).

## 丢了 admin token 怎么办

admin token（`ms_admin_xxx`）只在数据目录**第一次**启动时打印一次，库里只存了它的哈希——没有任何办法把原文找回来。丢了不代表要删库重来：

```bash
pnpm build   # 确保 scripts/admin-reset-token.mjs 依赖的 @moneyswitch/db、@moneyswitch/core 已构建
pnpm admin:reset-token -- --data-dir ~/.moneyswitch
```

（把 `~/.moneyswitch` 换成你实际的 `MONEYSWITCH_DATA_DIR`；`pnpm demo:local` 用的是 `.data/local`。）

这条命令直接操作该数据目录下的 `moneyswitch.sqlite`，生成一个新 admin token 并替换掉存储的哈希——**旧 token 立刻失效**，新 token 只打印这一次，同样不会被再次显示。server 不需要先停掉再跑这条命令：数据库是 WAL 模式，允许这条命令和正在运行的 server 同时读写同一个文件。跑完把新 token 记下来，其余管理接口（创建 Key、审批等）照常用新 token 调用即可。

不要对生产/测试网环境正在使用的数据目录随手跑这条命令——它会让所有已经分发出去的旧 admin token 立刻失效，需要重新分发。
