# MoneySwitch Solana integration (Devnet and mainnet)

This adds a real Ed25519 signer and the official `@x402/svm` exact-payment client for two clusters: **Solana Devnet** (test USDC, listed in `MONEYSWITCH_NETWORKS` to enable) and **Solana mainnet** (real USDC, an explicit opt-in like every other mainnet). MagicBlock is not integrated. This page is the single Solana guide; it replaces the former `solana-devnet.md` and `solana-mainnet.md`.

## Enable

Build and set the variables on the self-hosted server before restarting. To enable Solana Devnet alongside the existing testnets:

```sh
export MONEYSWITCH_NETWORKS=eip155:10143,eip155:84532,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
export MONEYSWITCH_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
pnpm build
pnpm --filter @moneyswitch/server start
```

To spend real USDC on Solana mainnet, append its CAIP-2 to the existing list, keeping the other entries and `MONEYSWITCH_DEFAULT_NETWORK` (Devnet and mainnet can be enabled together):

```sh
export MONEYSWITCH_NETWORKS=eip155:10143,eip155:84532,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
export MONEYSWITCH_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
export MONEYSWITCH_SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
```

The default configuration still enables only the testnets. The legacy `MONEYSWITCH_MAINNET_ENABLED` switch selects Monad only; it never enables Solana mainnet. Viewing the mainnet balance or funding the address does not enable mainnet payments and does not change the network type of existing MoneyKeys.

On the US deployment, a release package can enable it from its `/opt/moneyswitch/releases/<revision>` directory:

```sh
sh upgrade-us.sh --enable-solana-mainnet
```

The option reads the old container's effective network list, backs up the configuration, stops writes and verifies the data backup, then atomically appends Solana mainnet; existing networks, the default chain and other settings are kept. A legacy configuration without a network list keeps its effective Monad network. Unknown arguments are refused. If the configuration update, container start or health check fails, the old configuration and container are restored; data volumes are not removed, the wallet is not replaced and no payment is sent. An upgrade without the option adds no payment network.

The wallet page shows one separate Solana address, derived from the existing encrypted recovery phrase at `m/44'/501'/0'/0'`. No phrase or private key is passed to the agent. The same address exists on both clusters, with a separate USDC balance and token account per cluster; it differs from the EVM address even though both come from the same encrypted phrase. Older private-key-only wallets cannot derive a Solana address; use the existing replacement flow and keep the retired wallet's recovery material.

## Keys, funds and payment

Fund the address's associated token account with the cluster's own USDC:

- Devnet: Circle Devnet USDC, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (no monetary value).
- Mainnet: Circle USDC, mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals (**real money**).

Balances in other token accounts do not count as spendable through this client, and Devnet USDC can never pay mainnet.

Use a MoneyKey of the matching type: `network_mode: "mainnet"` pays only mainnet USDC and a testnet key only Devnet test USDC, even when both clusters are enabled. When both kinds are enabled, legacy keys without a type stay testnet-only, so an upgrade cannot make them spend real money. Budgets, allowed hosts, revocation and human approvals apply unchanged.

### Select a chain and annotate a bill

For a specific chain, `POST /v1/fetch` accepts `network` with the exact CAIP-2 identifier: Solana Devnet is `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, Base Sepolia `eip155:84532`. A requested chain must be enabled for the key and quoted by the seller; a key type mismatch, insufficient funds or an unavailable offer never falls back to another chain. Enabling a network charges nothing by itself. The installation test at `/x402-testnet/check` remains Monad-only. Refresh an existing agent's MoneySwitch skill to learn the new fields; keep its existing server URL and MoneyKey secret.

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

### Sellers and fees

The seller must quote x402 v2 `exact` on the configured Solana network and mint, with a distinct fee sponsor in `extra.feePayer`. The MoneySwitch wallet cannot be the fee sponsor: SOL spending would otherwise bypass its USDC budget. The sponsor (the seller's or its facilitator's) pays the SOL fee, so the MoneySwitch wallet never needs SOL; a seller that does not provide one is refused with `UNSUPPORTED_PAYMENT` before anything is signed.

The seller's facilitator must actually support that cluster, protocol version and scheme. The facilitator URL in the network configuration does not guarantee that an arbitrary seller can settle; a Devnet-only demo seller cannot be used for a real-money test, and an endpoint requiring CDP authentication is not usable without the matching server-side credentials.

### Solana Kit transport patch

The Node HTTP transport in Solana Kit 5.1.0 has a tracked pnpm patch at `patches/@solana__rpc-transport-http@5.1.0.patch`. It lets `fetch` calculate the body byte length. With the deployed Node 22 native fetch and shared Undici 7.30 dispatcher, Kit's manual length was duplicated into `157, 157` and rejected before signing. Undici's duplicate-header validation stays intact. The patch covers Node ESM and CommonJS entries; `pnpm install --frozen-lockfile` applies it in source builds. Loopback tests cover ASCII and Unicode byte lengths, and the US isolated-wallet pipeline reached the paid-request guard without sending a payment. Revalidate this regression before removing the patch during a dependency upgrade.

## Verification

- Offline SDK tests for both clusters construct the real SPL transfer (Devnet and mainnet USDC mints), independently verify the payer's Ed25519 signature, add a sponsor signature, and check that reconciliation uses the full fee-payer transaction ID on the matching cluster's RPC.
- Policy checks cover per-request refusal, mainnet/testnet separation, revoked keys, approval before signing, case-sensitive mint selection and refusal to spend the wallet's SOL as fees.
- The approval screen shows what a payment really does: the full recipient, the USDC mint, and the chain's family. A Solana approval names the quote's fee sponsor (`extra.feePayer`, recorded by migration `0014_approval_fee_payer`) and says that the wallet signs one USDC transfer. A test decodes the signed transaction and asserts exactly two compute-budget instructions, one SPL Token `TransferChecked` (never an approve or an authority change) and the memo, with the sponsor as fee payer; another asserts that the sponsor from a real 402 quote is recorded on the approval for both clusters. The dashboard renders only server-computed fields, so it needs no chain parsing of its own.
- Wallet tests cover lease/replacement protection and address persistence after restart. API tests cover the live and retired Solana addresses, the read-only mainnet balance shown while mainnet payments are disabled, the two clusters enabled at once (same derived address, a mainnet explorer link with no cluster, a Devnet link that names one, balances read from each cluster's RPC and mint), and the approval link's Solana fields.
- Ledger tests preserve signed reservations across restart, empty chain history and RPC failure; only a matching finalized transaction's success or execution failure resolves them.
- The SDK's mint RPC can stall. The caller deadline releases the lease, no signed payment is sent, and a late SDK operation cannot use the released signer.
- Read-only probes of the real RPCs (2026-10-11 Devnet, 2026-10-25 mainnet):
  - Devnet genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; mint initialized, 82 bytes, owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, 6 decimals, slot 509626593.
  - Mainnet genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` (the CAIP-2 id is its first 32 characters); mint initialized, 82 bytes, owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, 6 decimals, slot 461107591.

Offline tests and read-only probes do not prove settlement; the live payments below do.

### US external-seller verification, 2026-10-11 (testnets)

Release `4b29387` paid `https://x402.org/protected` through the normal `/v1/fetch` route, pinning each test network and limiting each payment to 0.01 test USDC. The dedicated keys were revoked after verification. Both settled ledger rows contain the request, recipient, asset, network, transaction and optional connectivity-test purpose.

- Base Sepolia: [0.01 USDC transaction](https://sepolia.basescan.org/tx/0x095a04dec1dbcc55e87c96abb69b0c0312a0c2606d5a3f8fa635deb71c7ea633), independently verified receipt success and matching USDC transfer, block `47961228`.
- Solana Devnet: [0.01 USDC transaction](https://explorer.solana.com/tx/3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu?cluster=devnet), independently verified finalized success and matching payer/recipient token-balance changes, slot `509781446`.

Only testnet tokens were transferred in that run. Earlier unsuccessful attempts and their uncertain ledger rows were preserved; these successful receipts do not rewrite or resolve older unknown records.

### US mainnet verification, 2026-10-25

A real Solana mainnet payment was verified on the project's US deployment (`app.moneyswitch.dev`, release revision `0c0e093`) — `0.005` USDC through the human-approval flow (first request `approval_required`, the administrator approves, the resend with the `approval_id` settles), finalized with the seller's fee sponsor paying the fee. A `0.01` test-USDC Devnet payment settled in the same run, and a request above the key's per-request limit returned `PER_REQUEST_LIMIT_EXCEEDED` with `charged: no`. Transactions, addresses and balances are recorded in [updates/2026-10-25-solana-live-payments.md](updates/2026-10-25-solana-live-payments.md). This does not replace a run from the exact revision you deploy: fund pocket money and repeat one payment, one refusal and one approval before trusting mainnet with more.

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

`--status` and refusal with an unfunded sponsor have been exercised. The harness's own `--pay` path still needs funded execution; do not describe this harness as a completed settlement demo until it prints a matched finalized transaction. (The live payments above went through the normal server, not this harness.)

## Recovery limitation

Signed transactions are persisted before the paid HTTP retry. Recovery matches the message hash and payer signature against finalized RPC transactions, including transactions found through the payer's latest 25 finalized history entries. A restart, timeout, RPC error, empty or pruned history, or an expired blockhash never proves that nothing was charged, so none of them releases the quota: it stays reserved until a matching finalized transaction proves success or execution failure. Old transactions can remain `unknown`; no automatic retry is safe while charge status is uncertain. Keep the bill and reconciliation evidence, and never delete an `unknown` record to retry a payment. Enabling mainnet and showing its balance is not a settlement verification; record a real payment's amount, transaction ID and finalized chain evidence separately.

## MagicBlock decision

MagicBlock's SDK delegates Solana accounts, executes against those accounts on an Ephemeral Rollup, and commits state back to Solana. Moving this product's existing SQLite budget reservation into that system requires a separate on-chain budget program and consistency/recovery design across the two stores. VRF does not serve its payment-policy requirements. This patch keeps the verified payment path small; it does not claim Blitz technical eligibility or a completed MagicBlock integration.

Official sources: [Solana clusters](https://solana.com/docs/references/clusters), [x402 SVM implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/svm), [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [MagicBlock SDK](https://github.com/magicblock-labs/ephemeral-rollups-sdk).

## Submission wording

MoneySwitch is a self-hosted spending gateway for AI agents. Each agent gets a MoneyKey with budgets, approved domains and human approvals; signing keys stay on the owner's server. It pays EVM chains with EIP-3009 x402 exact payments and Solana (Devnet, plus mainnet as an explicit opt-in) with the official exact-SVM SDK and an independent Ed25519 key derivation. Signed payment evidence survives restart, and uncertain charges remain reserved until matching finalized chain evidence resolves them. The US deployment settled real payments with independently verified chain evidence: 0.01 test USDC on Base Sepolia and Solana Devnet (2026-10-11), and 0.005 real USDC on Solana mainnet through a human approval (2026-10-25). Bills support optional purpose notes and on-demand transaction details. MagicBlock is not integrated.
