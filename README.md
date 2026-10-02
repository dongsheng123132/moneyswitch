# MoneySwitch

**Give your AI a budgeted API key for spending.** Self-host the same infrastructure for yourself, a team or an enterprise.

[Website](https://moneyswitch.dev) · [中文](README.zh-CN.md) · [Self-hosting guide](deploy/README.zh-CN.md)

The server holds an encrypted wallet and pays USDC through x402. Agents receive only a capped MoneyKey (`mk_live_…`). Total, daily and per-request budgets, allowed hosts, parent-key limits and manual approvals are checked before signing.

## Run this source

Node.js 22+ and pnpm are required. The v0.6 changes in this source are not represented by older npm releases.

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/server-pkg/dist/cli.js --data-dir ./data
# Offline tour, simulated settlement:
node apps/server-pkg/dist/cli.js demo --no-open
```

Open the first-run setup link, create an encrypted wallet and create a MoneyKey. Copy the personalized skill from the Dashboard to your agent. Each agent gets its own key and skill directory. Keys are stored as hashes; rotating a key revokes the old secret while retaining its budgets and history.

Skill + key is the primary integration. `GET /skill.md` serves generic instructions without secrets. HTTP API, MCP and the OpenAI-compatible gateway are additional callers.

## Deploy on your own server

[Docker Compose and HTTPS instructions](deploy/README.zh-CN.md) cover persistent storage, Caddy, health checks, backups and rollback. Your static website and service can use separate hosts, such as `moneyswitch.dev` and `app.moneyswitch.dev`. All data and wallet custody remain on your server.

Administrators manage wallets, keys, approvals and notifications. Members see their own budgets and history. Child keys inherit parent restrictions. Run a single server writer against a SQLite volume.

## Networks and payment outcomes

Supported networks: Monad testnet (`eip155:10143`), Base Sepolia (`eip155:84532`), Monad mainnet (`eip155:143`) and Base mainnet (`eip155:8453`). The legacy default remains Monad testnet. Set `MONEYSWITCH_NETWORKS` to an explicit list and `MONEYSWITCH_DEFAULT_NETWORK` to a member of that list. Selecting mainnet permits real USDC spending.

Only the configured USDC contract is accepted on each chain. Balances, receipts and reconciliation use the actual payment network. There are no swaps or cross-chain transfers.

`POST /v1/fetch` returns `charged: yes/no/maybe`. A timeout after signing, missing settlement proof or an incomplete paid response must not trigger blind retries. Reservations remain until reconciliation resolves the payment. Approval notifications use an independent outbox.

The OpenAI gateway exposes `/v1/models` and `/v1/chat/completions`. Current-key status and history are available at `/v1/status` and `/v1/history`. Health is `/healthz`.

v0.6 removes seller toll booths, `sell`, local desktop UI and automatic agent-configuration editing. Historical database tables remain intact; historical code is archived at `archive/tollbooth-v0.5`. The demo seller remains a test fixture.

## Validation and licensing

```sh
pnpm test
pnpm test:e2e
```

Offline tests verify real signatures with simulated settlement. Actual chain payments and deployed HTTPS/persistence require separate acceptance.

Server/core/Dashboard: AGPL-3.0-only. Client CLI/MCP: Apache-2.0. See each package LICENSE.
