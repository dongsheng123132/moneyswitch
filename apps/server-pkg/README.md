# moneyswitch-server

Give your AI an API key for money — the self-hosted
[MoneySwitch](https://github.com/dongsheng123132/moneyswitch) server and
Dashboard in one command.

MoneySwitch lets an AI agent hold a `mk_live_…` **MoneyKey** instead of a
wallet private key and spend USDC (Monad testnet) on
[x402](https://x402.org)-priced APIs, policy-checked before every payment
(budgets, per-request limits, host allowlist, human approval). It also puts a
**toll booth** in front of your own API so AI agents pay you per call.

## 30-second demo (offline, no real money)

```bash
npx moneyswitch-server demo
```

Starts a throwaway MoneySwitch on free local ports (from 4020 up) with a mock
x402 facilitator and a demo seller, pre-loads a mock wallet, a demo channel,
two MoneyKeys ("Claude Code", "Codex"), a toll booth and a few payments, and
opens the Dashboard already signed in (the server's own one-time setup link).
Every screen says **DEMO · simulated settlement — no real money moves**.
Ctrl+C stops everything and deletes the temporary data. `--no-open` prints
the link instead of opening a browser.

## Self-host

```bash
npx moneyswitch-server                       # http://127.0.0.1:4020
npx moneyswitch-server --data-dir /srv/moneyswitch --port 4020 --host 127.0.0.1
```

- Data (SQLite database + encrypted wallet keystore) lives in
  `~/.moneyswitch/server` by default (`--data-dir` or `MONEYSWITCH_DATA_DIR`).
- The first start of a data directory prints the admin token and a one-time
  setup link (valid 30 minutes, single use). Open it to create the wallet,
  add a channel and cut the first MoneyKey.
- Keep it on `127.0.0.1` unless it sits behind HTTPS / a reverse proxy.
  Other settings use the same `MONEYSWITCH_*` environment variables as the
  repository (`MONEYSWITCH_WALLET_PASSWORD(_FILE)`, `MONEYSWITCH_PUBLIC_URL`,
  `MONEYSWITCH_FACILITATOR_URL`, …).

Connect an agent with the client CLI (separate package, Apache-2.0):
`npx moneyswitch connect --server http://127.0.0.1:4020 --key mk_live_xxx --apply`.

## What's inside

One JavaScript bundle (server, core, db, x402, wallet, toll booth, mock
facilitator, demo seller and their dependencies), the prebuilt Dashboard and
the SQL migrations. The only runtime dependency is `better-sqlite3` (native, not bundled); its
npm package already contains prebuilt binaries for Windows, macOS and Linux
(glibc + musl), x64 and arm64 — no compiler and no extra download at install.
Requires Node.js 22 or newer (as does better-sqlite3 13).

## License

AGPL-3.0-only. See [LICENSE](./LICENSE). If you run a modified version as a
network service, you must offer its source to its users. The client CLI
[`moneyswitch`](https://www.npmjs.com/package/moneyswitch) is a separate
Apache-2.0 package.
