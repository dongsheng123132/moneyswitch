# MoneySwitch — Metropolis submission copy

Prepared on 2026-10-09 for the current self-hosted release. This is a local submission draft, not a record of submission. Values come from `submission-fields.json`. No actual video URL or private credential has been invented.

## Primary track

Trust, Identity & AI Infrastructure

Author note: Already selected in the supplied screenshot.

## Project logo

site/assets/img/moneyswitch-logo-512.png

Author note: Local PNG and public asset verified against the published source; upload this file in the submission form. Form upload remains pending.

Upload / media requirements: {"formats":["PNG","JPG","WebP"],"maximumBytes":2000000,"minimumPixels":500,"maximumTotalPixels":4000000,"note":"Screenshot states a minimum of 500 px; verify the exact dimension rule in the upload control."}.

Validated logo asset (form upload pending): `site/assets/img/moneyswitch-logo-512.png`. Verified public asset: https://moneyswitch.dev/assets/img/moneyswitch-logo-512.png

## Project name

Character count: 11 / 120.

MoneySwitch

## One-line description

Character count: 153 / 200.

A programmable, self-hosted Web3 cloud wallet for AI bots: separate spending keys, hard budgets and human approvals for USDC payments over x402 on Monad.

## Description

Character count: 4156 / 8000.

AI bots can write code, choose tools and request paid data. Their authority to spend should be explicit: how much, on which services, and when a person must decide.

MoneySwitch is a programmable Web3 cloud wallet for AI bots that the payer hosts and controls. A developer can run Codex on a laptop, Claude Code on a desktop and a background agent on a cloud server, while managing their spending permissions in one place. One payer funds the wallet. Each agent receives a separate, revocable MoneyKey with its own limits, rather than the wallet's private key. A key's budget is a spending ceiling, not a separately funded balance.

WHAT WORKS TODAY
The current self-hosted release has Wallet, Keys, Approvals and Bills. The operator creates a wallet and issues keys with daily and total budgets, a per-payment cap, allowed hosts, an expiry and an optional approval threshold. The generated skill instructions connect an agent through HTTP; the payment endpoint is POST /v1/fetch.

MoneySwitch checks the policy before signing. A payment at or above the approval threshold waits for the key holder's confirmation PIN or a logged-in administrator. A new public host also requires approval before it is contacted; approving adds that host to the key's allowlist. Hard spending caps still apply after approval. Keys can be revoked independently, blocking future requests without reversing payments that were already signed or settled.

Bills record the key, amount, requested URL, chain, transaction hash when available, and charged: yes / no / maybe. An uncertain payment result must not trigger an automatic retry. Mainnet and testnet amounts remain separate.

WHY MONAD
MoneySwitch pays supported x402 APIs using USDC on Monad mainnet and testnet. The seller returns an HTTP 402 payment requirement; the service evaluates it, signs an allowed EIP-3009 payment authorization, and retries the request with payment authorization. In this payment path the facilitator submits the settlement and pays gas, so the payer does not need MON for that transfer. Base is also supported; this is not an arbitrary-chain wallet, an automatic bridge or a way to pay every model subscription.

The Monad integration has a concrete paid-data use case. In a recorded September 27 mainnet run, a Qwen 3.8 Max research agent used a MoneyKey limited to api.nansen.ai, a $0.05 per-request cap and a $0.09 total budget. It selected and bought five Nansen queries, then stopped at the budget. The write-up links all five transaction hashes:
https://moneyswitch.dev/blog/qwen-agent-pays-nansen/

This is one historical demonstration run with earlier code, not a user count, a production traffic metric or a claim that the current hosted deployment has been revalidated. It demonstrates an agent choosing paid data while the wallet service enforces the spending boundary.

WHO CONTROLS THE WALLET
Cloud wallet means a service deployed on the payer's own infrastructure. One instance spends for one payer, whether an individual or an organization. MoneySwitch does not offer customer deposit accounts or a multi-tenant custodial service.

The server holds a hot wallet and remains trusted. Its compromise can put funds at risk. The service's system permissions must be isolated from agents, and mainnet balances should remain small. Keeping the private key out of the agent API is not protection against a compromised server or an agent that can edit its wallet files or database.

HOW TO EVALUATE IT
Start on Monad testnet with test USDC, which has no monetary value. Create two keys: one for an automatic test payment and one that requires approval at 0.01 test USDC. Give each agent its generated skill instructions, observe the first-payment flow, inspect the bill and revoke one key. This exercises the product's main claim: separate spending permissions for multiple bots, controlled by the payer.

MoneySwitch is open source. The next improvements should come from real deployment and connection friction, understandable approvals and reliable payment records. Task-purpose reporting, a sub-key management UI and stronger signer isolation are not presented as shipped features.

## Go-to-market strategy

Who are your first users, and how will you reach them?

Character count: 2120 / 8000.

Our first users are developers and small teams who already run multiple AI agents across local computers and cloud servers, and can operate a self-hosted service. The initial paid-use case is an agent buying a supported x402 API response, such as on-chain research data, while the payer controls budgets and approvals.

We are targeting a specific workflow rather than recruiting anyone who uses an AI chat product. A useful first trial connects two agent keys, makes a 0.01 test-USDC payment on Monad testnet, follows a human approval, reads the bill and checks revocation. Deployment failures and confusing instructions are useful feedback too. Test USDC has no monetary value.

Our outreach plan has three parts:
1. Publish concrete product and technical articles explaining the multi-device wallet, the server trust boundary and the recorded Qwen/Nansen experiment. Use the website, Chinese developer writing on Zhihu, English developer blogs and relevant self-hosting and agent communities to reach people with this workflow.
2. Invite developers to follow the testnet guide and report their environment, expected result, actual result and the step where they became stuck. GitHub issues provide a reproducible feedback channel; public reports must be redacted.
3. Turn small obstacles into contributions. Documentation fixes, minimal reproductions and clearer examples for connecting agents are suitable first PRs. The contribution guide gives interested developers a next step beyond trying the demo.

We will judge the trial by observed outcomes: whether someone can deploy the service, connect agents from another machine, understand an approval, distinguish paid from uncertain, and explain a bill. We will also ask which compatible services they actually want their agents to buy. Any adoption figures will be reported only after they have been measured; the five Nansen payments are evidence of a single experiment, not five users.

Contribution guide: https://moneyswitch.dev/contribute/
Testnet trial: https://moneyswitch.dev/pilot/
Product rationale: https://moneyswitch.dev/blog/cloud-wallet-for-ai-bots/

## GitHub repository

https://github.com/dongsheng123132/moneyswitch

## Live product

https://app.moneyswitch.dev

Author note: The app homepage, /healthz and the test endpoint HTTP 402 response passed anonymous read-only checks. Deployed app version, authenticated access, testnet-only judging configuration and dedicated judge credentials still need hands-on verification.

## Technical demo URL

**Missing:** Video and real accessible URL are not yet provided

Upload / media requirements: {"maximumDurationSeconds":180,"content":"Actual product demonstration, not a slide presentation or code walkthrough"}.

## Pitch URL

**Missing:** Video and real accessible URL are not yet provided

Upload / media requirements: {"maximumDurationSeconds":120,"content":"Actual team introduction, problem and why this project"}.

## Judge access instructions

Character count: 1890 / 8000.

Visibility: Private submission field.

MoneySwitch is self-hosted. You can evaluate it without receiving a shared administrator token by running your own instance from the public repository:
https://github.com/dongsheng123132/moneyswitch#readme
Cloud deployment instructions:
https://github.com/dongsheng123132/moneyswitch/tree/main/deploy

Use the default testnet configuration. Create a wallet in the dashboard and follow the wallet page's faucet instructions to obtain Monad testnet USDC. Test USDC has no monetary value. Keep the wallet service isolated from your agent's system permissions.

Create two testnet keys with the test endpoint allowed. For each, use total budget 0.05, daily budget 0.05 and per-payment cap 0.02, all in test USDC. Leave key A's approval threshold empty and set key B's to 0.01 when creating it. Keep the confirmation PIN with the person, not in the agent prompt.

Give each agent its own generated skill instructions. They guide the first test payment; do not manually duplicate that payment. A can pay within policy. B's 0.01 payment reaches the approval threshold and should wait. Open the approval link and approve with B's PIN, or use your own administrator session. Let the agent continue the same request.

Inspect Bills for the key, amount, URL, chain, charged status and confirmed transaction hash. For charged: maybe or a timeout, inspect the existing record instead of automatically retrying. Revoke A's key, then request only GET /v1/status with A; the request should be refused, without making another payment.

An isolated hosted testnet instance for private judge access is still pending configuration and verification. No hosted administrator token or agent credential is included in this draft. If hosted access is supplied, its details will be entered only in this private form field, with fresh testnet-only credentials. Public project materials must not contain those secrets.

Author note: Public self-hosted evaluation route drafted; dedicated private hosted judge access remains pending.

## Nansen integration explanation

Character count: 3011 / 8000.

MoneySwitch uses Nansen as a real paid-data source for a budget-constrained research agent, not as a static data display.

The demo in apps/qwen-agent uses Qwen 3.8 Max through Alibaba Cloud's OpenAI-compatible API. The model receives an endpoint catalog with prices and two tools: money_status and nansen_query. It decides which data is worth buying to answer a Monad research question. The query tool validates the chosen catalog endpoint and sends the request through MoneySwitch; the agent has a limited MoneyKey rather than the wallet's private key.

Nansen's x402 payment requirement provides the USDC price and supported settlement network. MoneySwitch applies the key policy before signing the EIP-3009 authorization and returns the purchased response and payment status. The recorded run used Monad mainnet and a key scoped to api.nansen.ai, with a $0.05 per-request cap and a $0.09 total budget.

On September 27, the agent investigated recent Monad token activity and whether smart money was participating. It first bought inexpensive screeners and a flow check, changed its query when stablecoins dominated the initial result, and only then bought the premium smart-money netflow endpoint. It produced an interpretation with limitations, listed its purchases and stopped when the budget was exhausted.

The five recorded Monad mainnet payments were:
1. Token screener by volume, $0.01:
https://monadvision.com/tx/0xb227e30f125cac1ab20977a5b9479ae538dacdec4295262173d643febc7ad540
2. Token screener by price change, $0.01:
https://monadvision.com/tx/0xc739c43296ed40a239bd148b60d6be230bae7a53c5795f68e389056520fc163f
3. Flow intelligence, $0.01:
https://monadvision.com/tx/0x99bf9da63699c1e6fd6e487bbbbfea882e882e29af30c6c178b0d277c82a2cb8
4. Token screener with only_smart_money, $0.01:
https://monadvision.com/tx/0x5fab3819a066e3f67e57109c2d6ff7f5a460d74fd6b9df4127c4bfbf4f4cf33b
5. Premium smart-money netflow, $0.05:
https://monadvision.com/tx/0xb7df99767f8ac3cff9ad05a3ebabe5e57a9a1ef9cc622ccad0afacab652de0b6
Total: $0.09 USDC in one recorded run. This is demonstration evidence, not a traffic or adoption metric. The historical run predates v0.7.5.

An earlier failed run also exposed a useful payment distinction: requests with invalid Nansen parameters did not settle, while signed authorizations initially kept budget reserved until their status could be reconciled. The integration's catalog validation and payment-status handling help the agent distinguish held budget from money actually spent.

The value beyond raw data is the research workflow: selecting queries under prices and a fixed budget, reformulating the question, stating uncertainty and returning a payment ledger alongside the answer. MoneySwitch supplies the enforceable spending boundary; Nansen supplies the research data.

Recorded experiment and transaction evidence:
https://moneyswitch.dev/blog/qwen-agent-pays-nansen/
Agent source and usage:
https://github.com/dongsheng123132/moneyswitch/tree/main/apps/qwen-agent

## Nansen demo URL

**Missing:** Optional video; no actual URL supplied

Upload / media requirements: {"maximumDurationSeconds":120}.

## Alibaba / Qwen 3.8 Max required link (exact form label pending verification)

**Missing:** Do not guess whether the field requests a demo, source, product or other evidence link; inspect the expanded field before choosing the value

## Product ad URL

**Missing:** Optional video; no actual URL supplied

Upload / media requirements: {"maximumDurationSeconds":30}.

## X profile

**Missing:** Actual profile has not been supplied; do not substitute an inferred username

## Alibaba / Qwen supporting evidence — field mapping pending

The Qwen 3.8 Max integration is the research agent described in the Nansen explanation. It uses `qwen3.8-max` through Alibaba Cloud DashScope, with `money_status` and `nansen_query` tools. The model selects the purchases; MoneySwitch enforces the key policy.

Source: https://github.com/dongsheng123132/moneyswitch/tree/main/apps/qwen-agent

Recorded run: https://moneyswitch.dev/blog/qwen-agent-pays-nansen/

These are real existing evidence links. Do not assume either satisfies the required Alibaba field until its exact label and instructions have been checked.

## Bounty selection — author action required

Retain the Nansen and Qwen selections if they match the verified official criteria. Remove the Mera selection because no implemented Mera integration is claimed. This draft has not changed the submission account.

## Publication and availability status

Website deployment `82c7839` is published. Public checks matched 22 resources to source files: 8 web pages, 6 Markdown files and 8 PNG images. An independent TinyFish external-network check also verified the media page, new article and contribution page. The official-site article, pilot and contribution links are live.

Pages deployment: https://github.com/dongsheng123132/moneyswitch/actions/runs/37883060669

The app homepage, `/healthz` and test-endpoint HTTP 402 response passed anonymous read-only checks. This does not verify the current app version, login flow or private judge credentials; those still require hands-on confirmation.

## Remaining required work

- Record an actual product technical demo of at most 3 minutes and supply its accessible URL.
- Record the pitch of at most 2 minutes with the real team identity and supply its accessible URL.
- Inspect the expanded Alibaba / Qwen required link field and supply the correct real URL.
- Verify the deployed app version, authenticated access, testnet-only judging configuration and dedicated judge credentials.

Only new work completed during the six-week hackathon window counts. The public repository history should be used to identify the eligible work.

Official screenshot deadline: October 14, 2026, 11:59 GMT+8.
