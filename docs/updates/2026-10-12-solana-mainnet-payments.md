# Solana mainnet payment activation

Deployment date: 2026-10-12 (Asia/Shanghai). This supersedes the earlier read-only deployment recorded in `2026-10-12-solana-mainnet-balance.md`.

The US server at `app.moneyswitch.dev` runs source revision `54f2981ff7927f62270dd43e30cc708e60cd9c7a`, image `moneyswitch:54f2981`, from `/opt/moneyswitch/releases/54f2981`. The user explicitly authorized Solana mainnet activation after confirming another deposit. No real payment was sent during this task.

The enabled list retains Monad testnet, Base Sepolia, Monad mainnet, Base mainnet and Solana Devnet, and appends `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. The default remains `eip155:10143`. Only mainnet MoneyKeys can pay on Solana mainnet; testnet and legacy untyped keys retain their existing restrictions. Wallet addresses, budgets and host allowlists were not changed.

The wallet API reports the actual mainnet payment switch and reuses the enabled-network balance query. The dashboard shows the enabled status above the normal mainnet balance row, with a mainnet explorer link. Instances without explicit opt-in keep the read-only display.

Validation completed:

- Dashboard: 238 tests and type check passed. Server wallet and adjacent policy tests: 103 tests and type check passed. x402 package: all 140 tests and type check passed. Full monorepo build passed.
- The official SDK integration test runs on both mainnet and Devnet identifiers with simulated RPC. It independently verifies the payer signature, sponsor fee payer, canonical mint, wallet and recipient associated token accounts, exactly one budgeted `TransferChecked`, six decimals and absence of extra funding instructions. Rejection, approval, revocation, unknown-payment quota retention, finalized reconciliation and stalled RPC paths pass.
- Upgrade script syntax and ten isolated upgrade/rollback scenarios passed. Original config is backed up before opt-in and restored byte-for-byte on failure. The actual encrypted-wallet backup checker passed before deployment.
- Built-package acceptance passed 31 checks with mainnet disabled and 33 with it enabled on Windows and isolated Linux containers. Linux acceptance used a read-only filesystem, no external network and disposable wallets. The mainnet run completed with exit status 0; a prior wrapper-only CRLF error after successful checks was eliminated by invoking the container command directly.
- Read-only US-server queries verified mainnet genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, the canonical initialized six-decimal Circle USDC mint, and PayAI's advertised x402 v2 exact-Solana mainnet fee sponsor.
- Live runtime configuration contains the new network; container image revision and current-release symlink match the source revision. Public `/healthz` returns `ok: true`; `/wallet` references the new `index-vOAybRf8.js`, and published asset hashes match the running image. Unauthenticated administrator access still returns 403.
- Before/after encrypted-wallet and unlock-file hashes and database record fingerprints match. All 22 MoneyKeys, 8 payments, administrator authentication, wallet metadata and retirement records remain intact; approval count remains 6.
- Finalized RPC confirms `160000` atomic USDC (0.16 USDC) in the existing mainnet associated token account. No real funds were spent by the activation or acceptance tests.

Backup: `/opt/moneyswitch/backups/20261012-160911`. Previous image: `moneyswitch:40e8012`; previous release: `/opt/moneyswitch/releases/40e8012`.

This activates the buyer payment path and verifies its policy and transaction construction. It does not constitute a real mainnet seller settlement test. The authenticated production screen was not inspected because the browser automation runtime was unavailable; frontend fixtures, isolated authenticated API acceptance, published assets, live config and chain balances were verified instead.
