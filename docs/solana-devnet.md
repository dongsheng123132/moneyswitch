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

## Select a chain and annotate a bill

For a specific chain, `POST /v1/fetch` accepts `network` with the exact CAIP-2 identifier. A requested chain must be enabled for the key and quoted by the seller; insufficient funds or an unavailable offer never fall back to another chain. Base Sepolia uses `eip155:84532`; Solana Devnet uses `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. The installation test at `/x402-testnet/check` remains Monad-only. Refresh an existing agent's MoneySwitch skill to learn the new fields; keep its existing server URL and MoneyKey secret.

An optional `purpose` of at most 160 Unicode characters labels the expense. It is a caller's explanation, not verified agent identity or proof of a task. Omit private project names, complete prompts and employee information. Omission does not affect payment ability. Bills show the key label, time, host, network, amount and charge status; the full URL, recipient, asset and transaction are available in expanded details. Purposes and complete request URLs are excluded from the default CSV. Display hiding does not restrict administrator access to stored records.

```json
{
  "url": "https://x402.org/protected",
  "method": "GET",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "max_price": "0.01",
  "purpose": "Public API connectivity test"
}
```

The official test seller currently quotes both test networks. Authorize its canonical host `x402.org:443`, without a `www` prefix: the `www` URL redirects, and MoneySwitch intentionally does not forward a payment through a cross-host redirect. A missing receipt or uncertain charge is not permission to repeat payment.

The Node HTTP transport in Solana Kit 5.1.0 has a tracked pnpm patch at `patches/@solana__rpc-transport-http@5.1.0.patch`. It lets `fetch` calculate the body byte length. With the deployed Node 22 native fetch and shared Undici 7.30 dispatcher, Kit's manual length was duplicated into `157, 157` and rejected before signing. Undici's duplicate-header validation stays intact. The patch covers Node ESM and CommonJS entries; `pnpm install --frozen-lockfile` applies it in source builds. Loopback tests cover ASCII and Unicode byte lengths, and the US isolated-wallet pipeline reached the paid-request guard without sending a payment. Revalidate this regression before removing the patch during a dependency upgrade.

## Verification

- Offline SDK test constructs the real SPL transfer, independently verifies the payer's Ed25519 signature, adds a sponsor signature, and checks that reconciliation uses the full fee-payer transaction ID.
- Policy checks cover per-request refusal, mainnet/testnet separation, revoked keys, approval before signing, case-sensitive mint selection and refusal to spend the wallet's SOL as fees.
- Wallet tests cover lease/replacement protection and address persistence after restart. API tests cover the live and retired Solana addresses and correct Devnet explorer links.
- Ledger tests preserve signed reservations across restart, empty chain history and RPC failure; only a matching finalized transaction's success or execution failure resolves them.
- The SDK's mint RPC can stall. The caller deadline releases the lease, no signed payment is sent, and a late SDK operation cannot use the released signer.
- A read-only probe of the real Devnet RPC returned genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. The configured mint was initialized, 82 bytes, owned by `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, with 6 decimals, at slot 509626593.

The offline tests and read-only probes above do not prove settlement. The external-seller verification below supplies a live transfer receipt; current Base/Monad demo videos still do not demonstrate a Solana approval or over-budget flow.

### US external-seller verification, 2026-10-11

Release `4b29387` paid `https://x402.org/protected` through the normal `/v1/fetch` route, pinning each test network and limiting each payment to 0.01 test USDC. The dedicated keys were revoked after verification. Both settled ledger rows contain the request, recipient, asset, network, transaction and optional connectivity-test purpose.

- Base Sepolia: [0.01 USDC transaction](https://sepolia.basescan.org/tx/0x095a04dec1dbcc55e87c96abb69b0c0312a0c2606d5a3f8fa635deb71c7ea633), independently verified receipt success and matching USDC transfer, block `47961228`.
- Solana Devnet: [0.01 USDC transaction](https://explorer.solana.com/tx/3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu?cluster=devnet), independently verified finalized success and matching payer/recipient token-balance changes, slot `509781446`.

Only testnet tokens were transferred. Solana mainnet payments remain disabled. Earlier unsuccessful attempts and their uncertain ledger rows were preserved; these successful receipts do not rewrite or resolve older unknown records.

### Isolated live-chain harness

After building, run from the repository root:

```sh
node scripts/demo-solana-devnet.mjs --prepare
node scripts/demo-solana-devnet.mjs --status
# Fund the printed payer with Circle Devnet USDC and the separate sponsor
# with at least 0.003 Devnet SOL. These are test tokens, not mainnet funds.
node scripts/demo-solana-devnet.mjs --pay
```

The harness keeps its encrypted wallets and ledger under `.data/solana-live/` (ignored by Git), pins the public Devnet RPC, checks its genesis before paying, and caps payment at 0.01 USDC. The seller is local and in-process; it sponsors and submits the transaction to the real Devnet RPC. This does not demonstrate an external HTTP seller or a public facilitator. The lost-receipt path keeps quota reserved, then matches finalized chain evidence before recording settlement. A saved payment prevents another automatic payment on rerun. Do not remove its ledger to retry an uncertain charge.

`--status` and refusal with an unfunded sponsor have been exercised. The live `--pay` path still needs funded execution; do not describe this harness as a completed settlement demo until it prints a matched finalized transaction.

## Recovery limitation

Signed transactions are persisted before the paid HTTP retry. Recovery matches the message hash and payer signature against finalized RPC transactions, including transactions found through the payer's latest 25 finalized history entries. Empty or pruned history, an expired blockhash, or an RPC error never releases the quota. Old transactions can remain `unknown`; no automatic retry is safe while charge status is uncertain.

## MagicBlock decision

MagicBlock's SDK delegates Solana accounts, executes against those accounts on an Ephemeral Rollup, and commits state back to Solana. Moving this product's existing SQLite budget reservation into that system requires a separate on-chain budget program and consistency/recovery design across the two stores. VRF does not serve its payment-policy requirements. This patch keeps the verified payment path small; it does not claim Blitz technical eligibility or a completed MagicBlock integration.

Official sources: [x402 SVM implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/svm), [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [MagicBlock SDK](https://github.com/magicblock-labs/ephemeral-rollups-sdk).

## Submission wording

MoneySwitch is a self-hosted spending gateway for AI agents. Each agent gets a MoneyKey with budgets, approved domains and human approvals; signing keys stay on the owner's server. This branch extends the existing EVM x402 payment flow to Solana Devnet USDC using the official exact-SVM SDK and independent Ed25519 key derivation. Signed payment evidence survives restart, and uncertain charges remain reserved until matching finalized chain evidence resolves them. The US deployment completed real 0.01-test-USDC payments on both Base Sepolia and Solana Devnet, with independently verified chain evidence. Bills support optional purpose notes and on-demand transaction details. MagicBlock is not integrated.
