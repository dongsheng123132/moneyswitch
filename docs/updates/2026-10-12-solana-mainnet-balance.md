# Wallet balance and navigation deployment

Deployment date: 2026-10-12 (Asia/Shanghai).

The US server at `app.moneyswitch.dev` now runs source revision
`40e8012fc91aff2f3569e9245eb81ba82909a373`, image `moneyswitch:40e8012`,
from `/opt/moneyswitch/releases/40e8012`.

- Removed the ended Demo Day presentation from the dashboard sidebar. The historical standalone page remains available.
- Display EVM and Solana addresses separately above the enabled payment-network balances.
- The administrator wallet API exposes `solana_mainnet_balance` separately from enabled payment networks, using the existing SPL balance reader, cache and timeout. Failed RPC reads report an unknown balance.
- Solana mainnet balances are for viewing only; `payments_enabled` is false. Solana mainnet was not added to the payment registry or enabled-network configuration.
- The US upgrade now checks that its backup includes the encrypted wallet and matching unlock file before switching images. The source release packager includes this checker.

Verification completed:

- Dashboard: 236 tests and TypeScript check passed.
- Server wallet routes: 47 tests passed; adjacent wallet hardening: 25 tests passed; server TypeScript check passed.
- Backup tests on Windows: 5 passed, 11 shell-dependent cases skipped. The actual US backup checker passed before deployment.
- Full monorepo build passed. Built-package acceptance passed 31 checks on Windows and 31 checks in an isolated Linux container on the US server, using disposable data and no real payments.
- Public `/wallet`, `/keys` and `/bills` HTML and all five hashed assets matched the deployed release. The JavaScript contains the mainnet balance display and no Demo Day sidebar link. Container health and public `/healthz` passed; the unauthenticated administrator wallet endpoint still returns 403.
- Before/after encrypted-wallet and unlock-file hashes and database record fingerprints matched. All 22 keys, 8 payments, administrator authentication record, wallet metadata and retirement records were retained.
- Read-only finalized Solana RPC queries independently confirmed the reported wallet's mainnet balance of 0.01 native Circle USDC and Devnet balance of 19.99 test USDC.

Rollback backup: `/opt/moneyswitch/backups/20261012-153029`.
Previous image: `moneyswitch:6097dc1`; previous release directory: `/opt/moneyswitch/releases/6097dc1`.

The authenticated production wallet screen was not inspected: the browser automation runtime failed to initialize. Verification instead covered rendered fixtures, the live deployment's public artifacts, unchanged production data and independent live-chain balance queries.
