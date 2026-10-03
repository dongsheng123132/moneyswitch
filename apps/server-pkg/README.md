# moneyswitch-server

Self-hosted MoneySwitch service and Dashboard: an AI spends from a capped key, anything over the approval line waits for a human, the private key is never given to the AI. AGPL-3.0-only; Node.js 22+. The specification is [SPEC.md](https://github.com/dongsheng123132/moneyswitch/blob/main/SPEC.md).

```sh
moneyswitch-server --data-dir ./data --port 4020
```

The first start prints an administrator token and a one-time sign-in link to the private terminal. Open the link, create the wallet on the Wallet page (12 recovery words, shown once), issue a key on the Keys page and paste its skill paragraph into your AI. The data directory holds the SQLite database and the wallet; **whoever can read it can spend the wallet**, so do not run the AI as the same system user or on the same machine. Set `MONEYSWITCH_PUBLIC_URL` to the HTTPS address people will use (approval links use it).

For persistent production use see [the deployment guide](https://github.com/dongsheng123132/moneyswitch/blob/main/deploy/README.zh-CN.md): Docker Compose behind HTTPS with a durable volume, health check, backup and rollback.

`MONEYSWITCH_NETWORKS` is an explicit list of Monad / Base mainnet or testnet CAIP-2 IDs. Only Monad testnet is enabled by default; a mainnet means real USDC. No swaps, no bridges. This source must be built before packaging; older npm releases do not represent it.
