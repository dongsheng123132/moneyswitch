# moneyswitch-server

Self-hosted MoneySwitch service and Dashboard for personal, team and enterprise use. AGPL-3.0-only; Node.js 22+.

```sh
moneyswitch-server --data-dir ./data --port 4020
```

The first start prints a one-time setup link and administrator credentials to the private terminal. The service stores SQLite data and an encrypted wallet in the selected directory. Copy a personalized skill and capped MoneyKey from the Dashboard to your AI. Use HTTPS for remote access.

For persistent production use, see [the source deployment guide](https://github.com/dongsheng123132/moneyswitch/blob/main/deploy/README.zh-CN.md). Docker Compose runs behind HTTPS with a durable volume, health checks, backups and rollback.

`MONEYSWITCH_NETWORKS` enables an explicit list of Monad/Base mainnet or testnet CAIP-2 IDs. The default is Monad testnet; selecting mainnet permits real USDC spending. No swaps or cross-chain transfers. Ledger entries retain their actual network.

v0.6 focuses on buyer infrastructure. Seller toll booths are removed; historical database tables are preserved. This source must be built before packaging; older npm releases do not represent these changes.
