# Monad Metropolis results: MoneySwitch selected in Alibaba Cloud's Qwen 3.8 Max bounty

![MoneySwitch: a programmable Web3 cloud wallet for AI bots.](https://moneyswitch.dev/assets/img/cloud-wallet-2026-10/cover-en.webp)

*The results of Monad's flagship hackathon Metropolis are out. MoneySwitch is on Alibaba Cloud's "Best Qwen 3.8 Max application" list.*

## What happened

Metropolis ran from September 1 to mid-October: 885 teams and 1,256 builders from 76 countries and regions. Beyond the four main tracks, ecosystem partners ran their own bounties. Alibaba Cloud's was "Best Qwen 3.8 Max application", and its list has three projects: Sandworm, Red Sentinel, and MoneySwitch (submitted under `@bitpus888`).

Let's be exact about what that is. It is not one of the four main-track prizes (those are three $10,000 places per track). It is a sponsor picking the projects it cares about on its own stack. What got picked was not another demo, but the chain of three things: a large model, a set of pay-per-call APIs, and a wallet whose limits were set by a human — and whether they actually work end to end.

## What we submitted

Two halves that meet in the middle.

**A self-hosted cloud wallet.** MoneySwitch never gives an agent a private key. It issues a **MoneyKey** instead: an API key for money, with a total budget, a per-request cap, a host allowlist, a human-approval line and one-click revocation. The agent calls `POST /v1/fetch`; the wallet **checks policy before it signs**, then pays the seller's x402 invoice in USDC from a local, low-balance vault. The agent never touches the private key.

**An agent that actually spends.** Qwen 3.8 Max got a key with a $0.09 budget and a price list, and decided by itself what to buy: four $0.01 queries on Monad mainnet to narrow the question, then one $0.05 query to settle whether smart money had shown up at all. Five real USDC payments, each one traceable on chain. The full run is written up in [the previous post](https://moneyswitch.dev/blog/qwen-agent-pays-nansen/).

## Why this route is worth picking

x402 already made *paying* easy: no sign-up, no API key, just a `402 Payment Required`, one EIP-3009 authorization, and a cent moves. The hard half is **authorization**: how much this agent may spend, where it may spend it, and when it has to stop and ask a human.

Our four boundaries are not things a smarter model can replace:

- **Policy runs before the signature.** Budgets, allowlists and approval lines are pre-signature checks, not after-the-fact reconciliation.
- **The human keeps a veto.** Payments above the approval line are held until someone approves them in the dashboard.
- **Every key keeps its own ledger.** Who spent what, and which on-chain transaction it maps to, in one view.
- **Failures are not guessed at.** When a seller answers 422 and never settles, the signed authorization is frozen rather than refunded; once it expires we ask the USDC contract whether it was ever used, and only then release the budget.

Qwen 3.8 Max proved the other half: give it a budget and a price list, and a capable model spends like an analyst, not like a retry loop.

## What actually ran on Monad

| Layer | Reality |
|---|---|
| Chain | Monad mainnet USDC over x402 (`eip155:143`), settled by the Molandak facilitator |
| Payments | 5 real USDC payments, $0.09 total, all verifiable on monadvision.com |
| Testnet demo | Two independent MoneyKeys, a direct payment, an approved payment, bills and key revocation — 2 min 02 s screen recording |

The cover illustrates the idea behind MoneySwitch: **your cloud, your wallet, your rules.**

## What comes next

The result is not a finish line; it is a confirmation that someone else reads the problem the same way. Three things follow:

1. **Try it.** Follow the [self-hosting and testnet guide](https://moneyswitch.dev/pilot/) and make your first testnet payment in about half an hour.
2. **Open an issue or a PR.** Docs, integration notes and small fixes are all welcome; the [first-PR guide](https://moneyswitch.dev/contribute/) has the steps.
3. **Bring a real use case.** If your agent reads paid data or calls paid APIs, tell us the scenario — we will change the product to fit it rather than to fit our imagination.

Thanks to the Monad and Alibaba Cloud reviewers, and to Sandworm and Red Sentinel for good company on the same list.

**Try it:** [self-hosting and testnet guide](https://moneyswitch.dev/pilot/) · [source code](https://github.com/dongsheng123132/moneyswitch) · [the Qwen run](https://moneyswitch.dev/blog/qwen-agent-pays-nansen/) · [product demo](https://moneyswitch.dev/videos/technical-demo/)
