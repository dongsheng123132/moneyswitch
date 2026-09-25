# Demo script (offline, no funds needed)

## One-command version

```bash
pnpm install
pnpm build
pnpm demo:local
```

Starts mock-facilitator (4099) + demo-seller (4021, pointed at the mock
facilitator) + server (4020, also serving the Dashboard at `/`) together,
data under `.data/local/` (gitignored), admin token printed once into
`.data/local/server.log`. Ctrl+C stops all three. See
`scripts/demo-local.mjs`.

For a real Monad testnet run (real facilitator, no mock, requires a
pre-funded wallet — see `docs/quickstart.md` step 5), instead run:

```bash
DEMO_SELLER_PAY_TO=0xYourRealAddress pnpm demo:testnet
```

`demo:testnet` refuses to start without `DEMO_SELLER_PAY_TO` set explicitly
(no default — this path can move real testnet USDC). It does not fund the
wallet or send any payment by itself; see `scripts/demo-testnet.mjs`.

## Manual, step-by-step version (what the one-command scripts do under the hood)

This is the exact sequence used to produce the M2/M4 acceptance evidence
for this build: mock-facilitator + demo-seller + server running locally,
hit via curl and via the MCP client.

```bash
pnpm build

# 1. mock-facilitator (offline, real EIP-3009 signature verification via viem)
MOCK_FACILITATOR_PORT=4099 node packages/mock-facilitator/dist/server.js &

# 2. demo-seller, pointed at the mock facilitator
DEMO_SELLER_PORT=4021 \
DEMO_SELLER_PAY_TO=0x<some address != MoneySwitch wallet address> \
DEMO_SELLER_FACILITATOR_URL=http://127.0.0.1:4099 \
node apps/demo-seller/dist/index.js &

# 3. MoneySwitch server
MONEYSWITCH_DATA_DIR=/tmp/ms-demo MONEYSWITCH_PORT=4020 node apps/server/dist/index.js &
# -> prints ms_admin_xxx once, save it as $ADMIN

curl -X POST http://127.0.0.1:4020/v1/admin/wallet/create \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"password":"demo-pw-123456"}'
curl -X POST http://127.0.0.1:4020/v1/admin/wallet/unlock \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"password":"demo-pw-123456"}'

curl -X POST http://127.0.0.1:4020/v1/keys \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"demo-agent","total_budget":"10","daily_budget":"5","per_request_limit":"1","approval_threshold":"0.10","allowed_hosts":["127.0.0.1:4021"]}'
# -> save the mk_live_xxx key as $MK

curl -X POST http://127.0.0.1:4020/v1/fetch -H "Authorization: Bearer $MK" -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:4021/free"}'
curl -X POST http://127.0.0.1:4020/v1/fetch -H "Authorization: Bearer $MK" -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:4021/premium-report"}'
curl -X POST http://127.0.0.1:4020/v1/fetch -H "Authorization: Bearer $MK" -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:4021/greedy"}'

MONEY_API_BASE=http://127.0.0.1:4020 MONEY_API_KEY=$MK \
  node scripts/mcp-client-check.mjs "http://127.0.0.1:4021/premium-report"
```

Expected outcomes:
- `/free` → `{"status":"ok", "payment": null, ...}`
- `/premium-report` → `{"status":"ok", "payment": {"amount":"0.01", "tx_hash":"0xmock...", "mock": true}, ...}`
- `/greedy` → `{"status":"denied", "code":"PER_REQUEST_LIMIT_EXCEEDED", ...}`
- The MCP client script lists all 3 tools and successfully calls each one.
