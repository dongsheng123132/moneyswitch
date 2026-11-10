# Aevum Builder Challenge #1 — submission

**Project:** MoneySwitch × QDay — a cloud wallet that lets an AI agent pay for API calls in tUSD8, with on-chain receipts.
**Track:** Native AI Assistants (agentic payments).
**Network:** QDay Aevum testnet, chain ID `44005`, asset tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`.
**Repo:** <https://github.com/dongsheng123132/moneyswitch> (branch `feat/qday-aevum-testnet`, PR #26) · AGPL-3.0.

---

## 1. The problem

An AI agent that calls paid APIs needs a way to pay per call that (a) does not hand the agent a wallet key, (b) has a
budget the owner set, and (c) leaves a receipt the owner can check. Card rails cannot do $0.01 calls; handing over a
private key fails (b) and (c). On QDay the missing pieces were not the token — tUSD8 already implements EIP-3009 — but the
x402 facilitator (QDay publishes none; its payment SDK is announced for Q1 2027) and a payee contract that gives the
payment an on-chain receipt.

## 2. What was built

```
AI agent ──(1) POST /v1/fetch {url, max_price} ──▶ MoneySwitch (cloud wallet, owns the key)
                                                      │  policy: per-request cap, daily cap, approval line, allowed hosts
                                                      ▼
                                          (2) GET paid API ─▶ seller replies 402 with a tUSD8 quote
                                                      ▼
                                          (3) wallet signs EIP-3009 TransferWithAuthorization (offline)
                                                      ▼
                                          (4) retries with the payment header
                                                      ▼
                             seller ──(5) /verify + /settle ──▶ qday-facilitator (this repo)
                                                                   │ relayer pays tQDAY gas
                                                                   ▼
                                       QDayPayReceiver.pay(orderId, …)  ── one transaction:
                                         · tUSD8.transferWithAuthorization(payer → contract)
                                         · contract → beneficiary (the merchant)
                                         · orders[orderId] = true, emit PaymentReceived
                                                      ▼
                                          (6) seller returns 200 + PAYMENT-RESPONSE receipt
                                          (7) the key's history shows status=settled + tx hash
```

Repo map: `packages/x402` (network registry + the paying client), `apps/qday-facilitator` (verifier + real settler),
`contracts/` (the payee contract and its Foundry suite), `apps/demo-seller` (a seller that quotes tUSD8),
`packages/x402/scripts` (fork/live/product demos, video capture).

## 3. QDay integration evidence

| Item | Value |
|---|---|
| Contract on Aevum testnet | `0xb4ef0d4028770f9851051f56c0d109864f2ec83c` (2937-byte runtime, identical to the `forge` artifact) |
| Deployment tx | `0x5b3e4bea2a6b2119a169cd881a294728b6dd5578eea6e0f02653d98c329e16b9` |
| Payment through the contract | `0x7d606cd9fae10dd47440e36734ed9018c4d8249800e38cefc4f1cf78f1727bed` |
| Payment through the product (`/v1/fetch`) | `0x51f5990866fcd05f42704cd9ef4941322f3ce747b219bc108e9006bffbc50052` |
| **Product-level payment, persistent wallet + dashboard** | `0xee39a716c29c14290ec064968d7e2e76e012de45ac542bae783945b0cba946cc` (block 2814404; wallet `0x739af5…32DB` 0.1 → 0.09 tUSD8) |

Every payment transaction carries the same four logs: tUSD8 `AuthorizationUsed` → tUSD8 transfer payer→contract →
tUSD8 transfer contract→beneficiary → `QDayPayReceiver.PaymentReceived(orderId, from, value, nonce, beneficiary)`. The
contract holds nothing between calls (balance 0 after each), and the beneficiary — the wallet that claimed the faucet —
went 0.90 → 0.93 tUSD8 across the three demo payments.

The last row is the one the screenshots and the video come from: a **persistent** MoneySwitch wallet
(`0x739af5…32DB`, funded with 0.1 tUSD8 by a plain transfer, tx `0x2f371aad…5741`) paid a seller through
`/v1/fetch` with a budgeted `qday-demo-agent` key, and the dashboard was screenshotted **in the same run**, so the bill
shows that very transaction hash. Reproduce with `bash packages/x402/scripts/qday-ui-shots.sh`.

Machine-checkable ledger with the read-only command for each claim: [`docs/qday/evidence.md`](evidence.md).

## 4. Judging criteria → where to look

| Criterion (weight) | Evidence |
|---|---|
| User experience & presentation (15) | The product has a real dashboard — the same one used for the Monad/Solana demos (`apps/dashboard`, served by the server, marketing site at moneyswitch.dev). These three screenshots are **real testnet data from the same run as the payment**: the bill with its on-chain transaction hash and "settled" status, the key's daily/cumulative budget and per-request cap, and the wallet's tUSD8 on QDay — [`media/dashboard-bills-live.png`](media/dashboard-bills-live.png), [`media/dashboard-keys-live.png`](media/dashboard-keys-live.png), [`media/dashboard-wallet-live.png`](media/dashboard-wallet-live.png). (The fork versions without the `-live` suffix are the same UI reproducible without spending testnet tUSD8.) |
| Demo clear & well structured (10) | [`media/demo-qday-final.mp4`](media/demo-qday-final.mp4) — 35 s: the terminal run of the real payment, then the dashboard (bill → key → wallet) and the explorer page for that same transaction. [`media/demo-qday-protocol.mp4`](media/demo-qday-protocol.mp4) adds the protocol view (straight x402 through `QDayPayReceiver`). Reproduce with `bash packages/x402/scripts/qday-ui-shots.sh` and `bash packages/x402/scripts/qday-run-all.sh`. |
| Comprehensive documentation (10) | [`README.md`](README.md) (on-chain facts, four test layers, human-only faucet steps), [`live-runbook.md`](live-runbook.md), [`evidence.md`](evidence.md), [`contracts/README.md`](../../contracts/README.md) (bytecode-check recipe, 9 gotchas). |
| Innovation & originality (20) | Budgeted agent key + human approval line + on-chain atomic receiver are combined: the agent never holds a key, the owner keeps revocation, and the replay/business-double-charge case is handled on-chain (`OrderAlreadyPaid`). |
| Technical quality & integration (15) | EIP-3009 verified against the token's own EIP-712 domain (not the seller's quote), replay refused via `authorizationState`, relay settlement idempotent per nonce, `pnpm test` 1244 passed / `pnpm test:e2e` 144 passed / `forge test` 28 passed. |
| Real-world utility (15) | $0.01-per-call APIs are uneconomical on card rails; the same wallet already settles on Monad/Base/Solana, so QDay is one more chain, not a new product. Path to mainnet: same code, USD8, real relayer key. |
| Safety, trust & controls (15) | Key never leaves the server; per-request/daily/total caps; approval threshold with 30-minute TTL; allowed-host allowlist; `authorizationState` replay check; on-chain `orderId` dedupe; contract non-upgradeable, holds no funds, `rescue()` forbids tUSD8. |

## 5. Run it

```bash
pnpm install && pnpm build
pnpm test && pnpm test:e2e

# offline, no faucet: the whole loop against an anvil fork of the real chain
node packages/x402/scripts/qday-x402-fork.mjs

# contracts
cd contracts && forge test && bash script/e2e-fork.sh

# with a funded demo wallet (tQDAY + tUSD8): deploy, pay, screenshot, render the protocol video
bash packages/x402/scripts/qday-run-all.sh

# with the product's persistent wallet (already holds tUSD8): pay through /v1/fetch and screenshot the dashboard
bash packages/x402/scripts/qday-ui-shots.sh
```

## 6. Assumptions, limitations, roadmap

- **Relayer is centralised.** The facilitator's relayer pays gas; in this demo it shares a key with the payer. Production
  wants a separate funded key with spending alerts.
- **Business idempotency is the seller's job.** `QDayPayReceiver.pay(orderId, …)` refuses a second payment for the same
  `orderId`; if a seller passes a nonce-derived id instead, the guarantee degrades to "the same authorization cannot be
  spent twice" — an HTTP loss plus a client retry that signs a *fresh* authorization would still charge twice.
- **Not audited.** 28 Foundry tests and a 245-line contract, but no third-party review; `setBeneficiary` and `rescue`
  are owner powers documented in `contracts/README.md §9`.
- **Build-window note, in the interest of honesty.** The starter kit was published during pre-registration and this
  integration was prototyped on 2026-11-10 (the commit dates), before the official window opened on 11-16. The UI polish
  and the submission-time re-verification land inside the window; the core design was already fixed.
- **Roadmap:** a browser UI for the owner (approvals + receipts), ERC-4337 session keys so an agent can pay gas itself,
  and an indexer so receipts render without RPC scans.
