# MoneySwitch Solana Devnet integration

This change adds a real Ed25519 signer and the official `@x402/svm` exact-payment client. It does not enable Solana mainnet or add MagicBlock.

## Enable

Build this branch and set the following variables on the self-hosted server before restarting:

```sh
export MONEYSWITCH_NETWORKS=eip155:10143,eip155:84532,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
export MONEYSWITCH_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
pnpm build
pnpm --filter @moneyswitch/server start
```

Use a testnet MoneyKey. The wallet page shows a separate Solana address, derived from the existing encrypted recovery phrase at `m/44'/501'/0'/0'`. No phrase or private key is passed to the agent. Older private-key-only wallets cannot derive a Solana address; use the existing replacement flow and keep the retired wallet's recovery material.

Fund that address's associated token account with Circle Devnet USDC, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Balances in other token accounts do not count as spendable through this client. Use a compatible x402 v2 seller accepting `exact` on the configured Solana network, with a distinct fee sponsor in `extra.feePayer`. The MoneySwitch wallet cannot be the fee sponsor: SOL spending would otherwise bypass its USDC budget.

## Verification

- Offline SDK test constructs the real SPL transfer, independently verifies the payer's Ed25519 signature, adds a sponsor signature, and checks that reconciliation uses the full fee-payer transaction ID.
- Policy checks cover per-request refusal, mainnet/testnet separation, revoked keys, approval before signing, case-sensitive mint selection and refusal to spend the wallet's SOL as fees.
- Wallet tests cover lease/replacement protection and address persistence after restart. API tests cover the live and retired Solana addresses and correct Devnet explorer links.
- Ledger tests preserve signed reservations across restart, empty chain history and RPC failure; only a matching finalized transaction's success or execution failure resolves them.
- The SDK's mint RPC can stall. The caller deadline releases the lease, no signed payment is sent, and a late SDK operation cannot use the released signer.
- A read-only probe of the real Devnet RPC returned genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. The configured mint was initialized, 82 bytes, owned by `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, with 6 decimals, at slot 509626593.

These tests do not prove a live USDC settlement. Before recording a Solana hackathon demo, fund a Devnet wallet, pay a compatible seller, inspect the full transaction on the Devnet explorer, then demonstrate a refused over-budget request and approval flow. Current Base/Monad demo videos do not demonstrate Solana.

## Recovery limitation

Signed transactions are persisted before the paid HTTP retry. Recovery matches the message hash and payer signature against finalized RPC transactions, including transactions found through the payer's latest 25 finalized history entries. Empty or pruned history, an expired blockhash, or an RPC error never releases the quota. Old transactions can remain `unknown`; no automatic retry is safe while charge status is uncertain.

## MagicBlock decision

MagicBlock's SDK delegates Solana accounts, executes against those accounts on an Ephemeral Rollup, and commits state back to Solana. Moving this product's existing SQLite budget reservation into that system requires a separate on-chain budget program and consistency/recovery design across the two stores. VRF does not serve its payment-policy requirements. This patch keeps the verified payment path small; it does not claim Blitz technical eligibility or a completed MagicBlock integration.

Official sources: [x402 SVM implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/svm), [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [MagicBlock SDK](https://github.com/magicblock-labs/ephemeral-rollups-sdk).

## Submission wording

MoneySwitch is a self-hosted spending gateway for AI agents. Each agent gets a MoneyKey with budgets, approved domains and human approvals; signing keys stay on the owner's server. This branch extends the existing EVM x402 payment flow to Solana Devnet USDC using the official exact-SVM SDK and independent Ed25519 key derivation. Signed payment evidence survives restart, and uncertain charges remain reserved until matching finalized chain evidence resolves them. SDK integration and policy tests pass; a live funded Solana settlement demo is still pending. MagicBlock is not integrated.
