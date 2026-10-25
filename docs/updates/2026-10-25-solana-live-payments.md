# Solana live payments verified on the US deployment (2026-10-25)

This records real end-to-end payments on the existing deployment, not a code change. Both clusters were exercised; the mainnet payment went through the human-approval flow.

## Deployment under test

- URL: <https://app.moneyswitch.dev>
- Host: `siliconvalley` / `43.172.94.101`
- Release: `/opt/moneyswitch/releases/0c0e093` (`REVISION` = `0c0e0934d6d38757ec1769242239f16c7abe21d3`), image `moneyswitch:0c0e093`, container `moneyswitch-server-1` (healthy)
- Enabled networks: `eip155:10143`, `eip155:84532`, `eip155:143`, `eip155:8453`, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`; default `eip155:10143`
- Wallets: EVM `0xC9e214824c9bC78ECcC505f4b02bB63BB8Ba7713`; Solana `FNyQi4CKkKdXDZEgPrGsC9LRioSxEZPHxfbm3L6LPF2y` (the same derived Solana address on Devnet and mainnet)
- Balances before the run: Solana mainnet USDC `0.15`, Solana Devnet USDC `19.99`

No application, wallet, network or configuration change was made for these tests. Temporary MoneyKeys were created for each run and revoked afterwards; the one approval was decided by the administrator. Administrator access was re-established for the run (the token is not stored in this repository).

## Earlier on-chain evidence (already present)

- Mainnet `0.01` USDC to CoinGecko's x402 endpoint, settled 2026-10-13: transaction `PwwnmH9fBXwgFZJhNfrHXHGJ6nN27TLBgTJTf6PhEnaBeco7CC9CKtRQGau2QfSH3bPr7P2mmLJbyjDePW74YWg`. The payer's USDC token account went `0.16 → 0.15`; the seller's `0.02 → 0.03`; finalized with no error.
- Devnet `0.01` test USDC to `https://x402.org/protected`, settled: transaction `3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu`. One older Devnet attempt remains `unknown` (the seller's response was lost); it is kept counted by design.

## 2026-10-25 run 1 — Solana mainnet, through a human approval (real USDC)

- Temporary key: `sol-mainnet-verify-20261025` (`7efddf37-4ef5-463c-8e09-8539d07e9666`), `network_mode: mainnet`, per-request `0.01`, approval threshold `0.001`, host `pro-api.coingecko.com:443`; revoked after the run.
- Request: `https://pro-api.coingecko.com/api/v3/x402/onchain/networks/solana/trending_pools`, `max_price: 0.006`, network pinned to Solana mainnet.
- The seller quoted `0.005` USDC on Solana mainnet: payTo `8XhngTRitTcTUJMiaDJ6azw8GRSiFPpwhnmV3HYQLHUpL`, fee sponsor `extra.feePayer` = `D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM`.
- First `/v1/fetch` returned `status: approval_required`, `charged: no`, approval `36bb3d5b-5e8f-490c-b3f8-bd92a16c726e` (network label `Solana mainnet`, amount `0.005`).
- The administrator approved it; the same request resent with `approval_id` returned `status: ok`, `charged: yes`, HTTP 200 from the seller (CoinGecko's trending-pools JSON), payment `0.005` USDC on `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.
- On-chain evidence, transaction `2bmGWtn7EPYNHeprZDtE9z8sXKkM838cjVAsBCSho8XPuQ4DvEhn1NP2uXLQtFjwTP87FMDVBx64WLHXLtBsrwrH`:
  - finalized RPC (`getTransaction`, `commitment: finalized`): slot `461119206`, no error, fee `10001` lamports;
  - fee payer and first signature: the seller's sponsor `D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM` (SOL fee did not come from MoneySwitch);
  - MoneySwitch payer `FNyQi4CKkKdXDZEgPrGsC9LRioSxEZPHxfbm3L6LPF2y` is the second signer and the transfer authority;
  - one SPL Token `transferChecked` of `0.005` of Circle mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, plus the memo and compute-budget instructions;
  - token deltas: payer `0.15 → 0.145`, seller `0.29 → 0.295`.
- After the run: mainnet balance `0.145`, key revoked.

## 2026-10-25 run 2 — Solana Devnet, direct payment (test USDC)

- Temporary key: `sol-devnet-verify-20261025` (`19aae356-4b40-4d5e-9631-d2a36ba1a710`), `network_mode: testnet`, per-request `0.02`; revoked after the run.
- Request: `https://x402.org/protected`, no approval required (below its threshold).
- Result: `status: ok`, `charged: yes`, `0.01` test USDC; transaction `3moG5kC9xi4ZQSuNtknr366angNRPsDCxaaqse7PYtt5XG9HJbQ51DCT4Zwo1YtvmtHdNB32yFPuYzLDr6RDBpBK`.
- Finalized on Devnet: slot `514847688`, no error, fee `10001` lamports paid by the seller's sponsor `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`; that sponsor gained `0.01`, the MoneySwitch address went `19.99 → 19.98`; one `transferChecked` of the Devnet USDC mint.
- After the run: Devnet balance `19.98`, key revoked.

## 2026-10-25 run 3 — refusal (no charge)

- Temporary key: `sol-mainnet-refusal-2` (`1ea126a7-3999-4b92-88d9-6546eb0524af`), per-request limit `0.002` (below the seller's `0.005` quote).
- `/v1/fetch` returned `status: denied`, `code: PER_REQUEST_LIMIT_EXCEEDED`, `charged: no`; no payment row, nothing signed, wallet unchanged. Key revoked.

## Spend and state

- Real money spent: `0.005` USDC on Solana mainnet. Test tokens spent: `0.01` on Solana Devnet.
- Final balances: Solana mainnet `0.145` USDC, Solana Devnet `19.98` USDC.
- All three temporary keys are revoked; the approved request is `used`; the new payment rows are `settled` and visible in the deployment's Bills page.

## What this proves and what it does not

- Proves the deployed release (`0c0e093`) can construct, sign, submit and settle an x402 v2 `exact` SVM USDC payment on **Solana mainnet** with the seller's fee sponsor paying the SOL fee, that the human approval binds and is required before signing, that a refused request signs and charges nothing, and that the same code path settles on **Solana Devnet**.
- Does not prove a run from a different release revision, an external seller with a different facilitator outside this x402 `exact` SVM shape, or availability of the same sellers over time.
