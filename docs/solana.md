# MoneySwitch Solana integration (Devnet and mainnet)

This adds a real Ed25519 signer and the official `@x402/svm` exact-payment client for two clusters: **Solana Devnet** (test USDC, listed in `MONEYSWITCH_NETWORKS` to enable) and **Solana mainnet** (real USDC, an explicit opt-in like every other mainnet). MagicBlock is not integrated.

## Enable

Build and set the variables on the self-hosted server before restarting. To enable Solana Devnet alongside the existing testnets:

```sh
export MONEYSWITCH_NETWORKS=eip155:10143,eip155:84532,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
export MONEYSWITCH_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
pnpm build
pnpm --filter @moneyswitch/server start
```

To spend real USDC on Solana mainnet, list its CAIP-2 explicitly (Devnet and mainnet can be enabled together):

```sh
export MONEYSWITCH_NETWORKS=eip155:10143,eip155:84532,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
export MONEYSWITCH_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
export MONEYSWITCH_SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
```

The wallet page shows one separate Solana address, derived from the existing encrypted recovery phrase at `m/44'/501'/0'/0'`. No phrase or private key is passed to the agent. The same address exists on both clusters, with a separate USDC balance and token account per cluster. Older private-key-only wallets cannot derive a Solana address; use the existing replacement flow and keep the retired wallet's recovery material. A mainnet key pays only mainnet USDC and a testnet key only Devnet test USDC, even when both clusters are enabled.

## Fund and pay

Fund the address's associated token account with the cluster's own USDC:

- Devnet: Circle Devnet USDC, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (no monetary value).
- Mainnet: Circle USDC, mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (**real money**).

Balances in other token accounts do not count as spendable through this client. Use a compatible x402 v2 seller accepting `exact` on the configured Solana network, with a distinct fee sponsor in `extra.feePayer`. The MoneySwitch wallet cannot be the fee sponsor: SOL spending would otherwise bypass its USDC budget. On mainnet that sponsor is what makes a payment gasless for this wallet; a seller that does not provide one is refused with `UNSUPPORTED_PAYMENT` before anything is signed.

## Verification

- Offline SDK tests for both clusters construct the real SPL transfer (Devnet and mainnet USDC mints), independently verify the payer's Ed25519 signature, add a sponsor signature, and check that reconciliation uses the full fee-payer transaction ID on the matching cluster's RPC.
- Policy checks cover per-request refusal, mainnet/testnet separation, revoked keys, approval before signing, case-sensitive mint selection and refusal to spend the wallet's SOL as fees.
- The approval screen shows what a payment really does: the full recipient, the USDC mint, and the chain's family. A Solana approval names the quote's fee sponsor (`extra.feePayer`, recorded by migration `0012_approval_fee_payer`) and says that the wallet signs one USDC transfer. A test decodes the signed transaction and asserts exactly two compute-budget instructions, one SPL Token `TransferChecked` (never an approve or an authority change) and the memo, with the sponsor as fee payer. The dashboard renders only server-computed fields, so it needs no chain parsing of its own.
- Wallet tests cover lease/replacement protection and address persistence after restart. API tests cover the live and retired Solana addresses, the two clusters enabled at once (same derived address, a mainnet explorer link with no cluster, a Devnet link that names one, balances read from each cluster's RPC and mint), and the approval link's Solana fields.
- Ledger tests preserve signed reservations across restart, empty chain history and RPC failure; only a matching finalized transaction's success or execution failure resolves them.
- The SDK's mint RPC can stall. The caller deadline releases the lease, no signed payment is sent, and a late SDK operation cannot use the released signer.
- Read-only probes of the real RPCs (2026-10-11 Devnet, 2026-10-25 mainnet):
  - Devnet genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; mint initialized, 82 bytes, owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, 6 decimals, slot 509626593.
  - Mainnet genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` (the CAIP-2 id is its first 32 characters); mint initialized, 82 bytes, owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, 6 decimals, slot 461107591.

Live evidence (2026-10-25): a real Solana mainnet payment was verified on the project's US deployment (`app.moneyswitch.dev`, release revision `0c0e093`) — `0.005` USDC through the human-approval flow (first request `approval_required`, the administrator approves, the resend with the `approval_id` settles), finalized with the seller's fee sponsor paying the fee. A `0.01` test-USDC Devnet payment settled in the same run, and a request above the key's per-request limit returned `PER_REQUEST_LIMIT_EXCEEDED` with `charged: no`. Transactions, addresses and balances are recorded in [updates/2026-10-25-solana-live-payments.md](updates/2026-10-25-solana-live-payments.md). This does not replace a run from the exact revision you deploy: fund pocket money and repeat one payment, one refusal and one approval before trusting mainnet with more.

### Isolated live-chain harness (Devnet only)

After building, run from the repository root:

```sh
node scripts/demo-solana-devnet.mjs --prepare
node scripts/demo-solana-devnet.mjs --status
# Fund the printed payer with Circle Devnet USDC and the separate sponsor
# with at least 0.003 Devnet SOL. These are test tokens, not mainnet funds.
node scripts/demo-solana-devnet.mjs --pay
```

The harness keeps its encrypted wallets and ledger under `.data/solana-live/` (ignored by Git), pins the public Devnet RPC, checks its genesis before paying, and caps payment at 0.01 USDC. The seller is local and in-process; it sponsors and submits the transaction to the real Devnet RPC. This does not demonstrate an external HTTP seller or a public facilitator. The lost-receipt path keeps quota reserved, then matches finalized chain evidence before recording settlement. A saved payment prevents another automatic payment on rerun. Do not remove its ledger to retry an uncertain charge. **It cannot touch Solana mainnet** (it refuses any other RPC), by design.

`--status` and refusal with an unfunded sponsor have been exercised. The live `--pay` path still needs funded execution; do not describe this harness as a completed settlement demo until it prints a matched finalized transaction.

## Recovery limitation

Signed transactions are persisted before the paid HTTP retry. Recovery matches the message hash and payer signature against finalized RPC transactions, including transactions found through the payer's latest 25 finalized history entries. Empty or pruned history, an expired blockhash, or an RPC error never releases the quota. Old transactions can remain `unknown`; no automatic retry is safe while charge status is uncertain.

## MagicBlock decision

MagicBlock's SDK delegates Solana accounts, executes against those accounts on an Ephemeral Rollup, and commits state back to Solana. Moving this product's existing SQLite budget reservation into that system requires a separate on-chain budget program and consistency/recovery design across the two stores. VRF does not serve its payment-policy requirements. This patch keeps the verified payment path small; it does not claim Blitz technical eligibility or a completed MagicBlock integration.

Official sources: [x402 SVM implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/svm), [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [MagicBlock SDK](https://github.com/magicblock-labs/ephemeral-rollups-sdk).

## Submission wording

MoneySwitch is a self-hosted spending gateway for AI agents. Each agent gets a MoneyKey with budgets, approved domains and human approvals; signing keys stay on the owner's server. It pays EVM chains with EIP-3009 x402 exact payments and Solana (Devnet, plus mainnet as an explicit opt-in) with the official exact-SVM SDK and an independent Ed25519 key derivation. Signed payment evidence survives restart, and uncertain charges remain reserved until matching finalized chain evidence resolves them. SDK integration and policy tests pass; a live funded Solana settlement is still pending. MagicBlock is not integrated.
