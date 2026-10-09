# I gave Qwen 3.8 Max a $0.09 budget and a MoneyKey. It bought its own Nansen data on Monad mainnet.

*Published case study for the Monad Metropolis hackathon (Qwen 3.8 Max and Nansen bounties). This article documents the September 27, 2026 experiment; every transaction below is on Monad mainnet and can be checked on monadvision.com.*

## The question

"What's hot on Monad in the last 24 hours, and is smart money buying it?"

That's an easy question to ask and an expensive one to answer well. The data exists — Nansen has token screeners, flow intelligence and smart-money labels for Monad — but it's pay-per-call. So the real question is: **can an AI agent decide what data is worth buying, pay for it itself, and stay inside a budget a human set?**

That's what MoneySwitch is for. MoneySwitch gives an agent a `mk_live_…` **MoneyKey**: an API key for money. It is not a private key and it is not money — it's a revocable spending permission with a total budget, a per-request cap and a host allowlist. The agent calls `POST /v1/fetch`; MoneySwitch checks the policy *before* signing, then pays the seller's x402 invoice in USDC from a local, low-balance vault. The agent never touches a private key.

For this run the MoneyKey was scoped to `api.nansen.ai`, $0.05 max per request, **$0.09 total**.

## Why Nansen fits perfectly

Nansen sells its API over **x402 v2**, and — the part that made this possible — its 402 invoice accepts **USDC on Monad mainnet** (`eip155:143`, settled via the Molandak facilitator, the same one Monad's docs use). No Nansen account, no API key: a request without credentials gets a `402 Payment Required`, the client signs an EIP-3009 USDC authorization, retries, and gets data back. Basic endpoints cost $0.01, smart-money endpoints $0.05.

The agent had five endpoints in its catalog, all with `monad` as the chain:

| Endpoint | Price | What it's for |
|---|---|---|
| `POST /api/v1/token-screener` | $0.01 | ranked tokens: volume, price change, buy/sell volume, netflow, liquidity; filters incl. `only_smart_money`, `include_stablecoins` |
| `POST /api/v1/tgm/flow-intelligence` | $0.01 | per-token net flow by cohort: smart traders, whales, top PnL, public figures, exchanges, fresh wallets |
| `POST /api/v1/tgm/dex-trades` | $0.01 | individual DEX trades for a token over a date range |
| `POST /api/v1/smart-money/netflow` | $0.05 | chain-wide smart-money net flow, sortable by `net_flow_24h_usd` |
| `POST /api/v1/smart-money/holdings` | $0.05 | what smart money currently holds |

The request schemas are checked in CI against Nansen's published OpenAPI spec (`https://api.nansen.ai/openapi.json`) — more on why below.

## Why Qwen 3.8 Max

The agent is a plain tool-calling loop: Qwen 3.8 Max (`qwen3.8-max` via Alibaba Cloud's OpenAI-compatible endpoint) gets two tools — `money_status` (how much budget is left) and `nansen_query` (buy one catalog endpoint) — and a system prompt that says: you are an on-chain analyst with a hard USDC budget; state a plan; prefer the cheapest data that answers the question; don't buy redundant data; stop when the next call isn't affordable; and account for every cent you spend.

There is no hard-coded "research flow". Every decision below — what to buy, in which order, when to escalate to the $0.05 endpoint, when to stop — was Qwen's.

## What it actually did

**1. Checked the budget, bought the cheapest thing ($0.01).** Token screener, Monad, 24h, sorted by volume. Result: USDC $10.6M, MUSD $4.3M, WMON $1.7M, WETH $1.6M, EURW $1.5M.

Qwen's read: *"almost entirely stablecoins and wrapped natives — not really 'hot' in the speculative sense."* Instead of answering with that, it spent another cent.

**2. Re-asked the question properly ($0.01).** Same screener, stablecoins excluded, sorted by 24h price change. Now the real movers appear: ANAGO +18.8%, EMO +13.7%, SHRAMP +13.1%, FLING +7.0%, BOB +4.5% — all micro-caps.

**3. Checked the top mover cheaply before paying premium ($0.01).** Flow intelligence on ANAGO: every labeled cohort — smart traders, whales, top PnL, public figures, fresh wallets — at **$0 net flow**. Only exchange flow moved (−$1,320).

**4. Checked the whole chain cheaply ($0.01).** Screener with `only_smart_money: true`: **zero rows**.

**5. Only now paid for the premium signal ($0.05).** Qwen noted that zero rows is ambiguous — genuine absence vs. a filter artifact — so it bought the endpoint built for exactly this question: smart-money netflow, ranked by 24h net flow, with stablecoins and native tokens *included* "so the call can't come back empty for filter reasons". Result: **zero rows chain-wide**.

**Answer:** the 24h strength in Monad micro-caps is retail/bot flow; there is no smart-money participation behind ANAGO, EMO, SHRAMP, FLING or BOB. ANAGO's +18.8% came on about **$2.1k of volume** against $14.7k of liquidity. Qwen also flagged its own uncertainty ("can't distinguish 'smart money is absent' from 'Nansen's smart-money coverage on Monad is still thin'") and refused to use token-age fields that were obviously broken (deployment dates of 1970-01-01).

It ended with a ledger:

| Call | Price | Tx (Monad mainnet) |
|---|---|---|
| token-screener, by volume | $0.01 | `0xb227e30f…d540` |
| token-screener, by price change | $0.01 | `0xc739c432…163f` |
| flow-intelligence, ANAGO | $0.01 | `0x99bf9da6…2cb8` |
| token-screener, only_smart_money | $0.01 | `0x5fab3819…f33b` |
| smart-money-netflow (premium) | $0.05 | `0xb7df9976…e0b6` |
| **Total** | **$0.09** | budget exhausted, nothing over |

We verified all five independently: each receipt has status 1 and a USDC `Transfer` from the agent's vault to Nansen's payTo address, and the vault's on-chain balance dropped by exactly $0.09. The vault holds **0 MON** — the facilitator pays gas.

## What Qwen brought

- **Planning under a price list.** It treated $0.01 vs $0.05 as a real trade-off: three cheap queries to narrow the question before one expensive one to confirm it. A naive agent calls the premium endpoint first.
- **Reformulating, not just retrying.** The first screener result was technically an answer; Qwen recognized it was the wrong answer and changed the sort and filters.
- **Honest uncertainty.** Zero rows got treated as a claim to be tested, not a conclusion — and the final answer says what the data can't tell you.
- **Accounting.** It separated money *spent* (has a tx hash) from money merely *held* (see below), and reported both.

## The failure that made it better

The first live run went wrong in an instructive way. Two of our hand-written request schemas didn't match Nansen's API (`smart-money/netflow` has no `timeframe`; `flow-intelligence` wants a singular `chain` and `1d`, not `24h`). Nansen answered those paid requests with **HTTP 422 — and never settled them**.

Three things happened, all of which we now rely on:

1. **No money moved.** The vault balance went down by exactly the one successful $0.01 call.
2. **MoneySwitch held the budget instead of guessing.** A signed EIP-3009 authorization stays valid until it expires, and a seller *could* still settle it late — so the $0.06 was reserved, not released. After expiry, MoneySwitch's reconciler asked the USDC contract (`authorizationState`) whether those authorizations were ever used, found they weren't, marked them `NOT_SETTLED_EXPIRED`, and restored the budget.
3. **The agent learned to say "held, not spent".** In that first run Qwen reported the $0.06 as "deducted with no tx hash to dispute" — a fair complaint. The tool now tells it explicitly when an amount is held pending expiry, and the catalog is generated against Nansen's OpenAPI spec with a test that fails if they drift.

## Why this matters

Paid APIs for agents are coming — x402 makes the payment part simple. The hard part is the **permission** part: how much can this agent spend, on what, and how do you stop it. A MoneyKey answers that the way developers already understand: like an API key, with a budget, an allowlist and a revoke button, and with the policy enforced *before* anything is signed.

Qwen 3.8 Max showed the other half: given a budget and a price list, a capable model spends like an analyst, not like a loop.

**Try it:** [self-hosting and testnet guide](https://moneyswitch.dev/pilot/) · [source code](https://github.com/dongsheng123132/moneyswitch) · [Qwen agent](https://github.com/dongsheng123132/moneyswitch/tree/main/apps/qwen-agent) · [experiment runbook](https://github.com/dongsheng123132/moneyswitch/blob/main/docs/nansen-mainnet.md)
