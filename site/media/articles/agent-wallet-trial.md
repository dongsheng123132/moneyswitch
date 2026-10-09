# Help test MoneySwitch with two agents and one self-hosted wallet

![Many agents, one spending wallet you control. MoneySwitch early trial.](https://moneyswitch.dev/assets/img/launch-2026-10/cover-en.webp)

Do you run Codex on one computer, Claude Code on another, or agents split between your own machines and the cloud? We are looking for developers to try MoneySwitch in that kind of setup and tell us where it breaks down.

**MoneySwitch is a programmable spending wallet for multiple agents that you host yourself.** Its server holds the wallet; each agent receives a separate MoneyKey with a spending policy. Today it pays compatible x402 APIs in USDC on Monad and Base, with testnets enabled by default.

This is an early self-hosted trial. You deploy and control the service, and one instance spends for one payer. There is no hosted signup account or shared customer balance.

## Who this trial is for

- You already use at least two agents, or the same kind of agent on different machines.
- You can deploy a service yourself and keep its system permissions separate from your agents.
- You want to test budgets and approvals for agent purchases, and can describe what did and did not work.

You do not need to put real money into the trial. The suggested payment uses **0.01 test USDC on Monad testnet**. Test USDC has no monetary value. We may offer rewards at our discretion based on trial participation and feedback. Reward details and criteria will be announced separately; participation does not guarantee a reward or a fixed amount. Honest criticism is welcome too.

## What to try

The [trial page](https://moneyswitch.dev/pilot/) has the setup path. We would like you to exercise these steps:

1. **Deploy your wallet service.** Follow the current self-hosting instructions, keep testnets enabled, and create a wallet in the dashboard. Use its faucet instructions to obtain Monad testnet USDC. Keep the agent away from the server's wallet files, database and administrator credentials.
2. **Connect two agents.** Create a separate testnet key for each, with the test endpoint allowed. For each, set the total budget to 0.05, daily budget to 0.05 and per-payment cap to 0.02, all in test USDC. Leave agent A's approval threshold empty and set agent B's to 0.01 when creating the keys. Give each agent its own generated skill instructions. Keep the confirmation PIN with the person responsible for that key.
3. **Observe the first test payment.** The generated instructions guide agent A through the 0.01 test-USDC payment on Monad testnet. Check its result and transaction hash; do not manually repeat the same test. If payment status is uncertain, inspect it before trying again.
4. **Try a human decision.** Agent B's payment reaches its 0.01 approval threshold and should wait. Open the link and use the key's PIN, or approve as an administrator, then let the agent continue the same request. Also check whether the rejection path is clear.
5. **Read the bill and revoke a key.** Can you identify the key, amount, URL, chain, transaction hash and charged status? Revoke A's key, then have A only request `GET /v1/status` and confirm that it is refused. No further payment is needed. The other agent has its own key; revocation does not reverse a completed payment.

If a step fails, that is useful feedback. You do not need to force a successful result to participate.

## The feedback we want

Tell us what you were trying to do, which agents and machines you used, and the first point where the product stopped making sense. In particular:

- Was self-hosting clear enough, including connecting an agent from another machine?
- Did the key limits and the approval request match what you expected?
- Could you tell the difference between paid, not paid and uncertain?
- After revoking a key, was it obvious what had stopped and what had already happened?
- What real API would you want an agent to pay for, and does it offer a compatible payment method?

We are looking for concrete friction and missing workflows. Honest reports of “I do not need this” are useful too.

## What to expect from the current product

MoneySwitch does not pay arbitrary model subscriptions. Its supported payment path is x402, and a seller must accept a compatible payment scheme and chain. Bills record payment details; they do not yet explain an agent's whole task or judge whether its purchase was useful.

The wallet is a server-side hot wallet. Keeping the private key off agent machines reduces what those machines need to hold, but the wallet service remains trusted. A server compromise can put funds at risk. Use testnet for this trial and read the deployment and security documentation before considering mainnet.

## Start the trial and send feedback

**[Open the MoneySwitch trial guide](https://moneyswitch.dev/pilot/)**, then [open a GitHub feedback issue](https://github.com/dongsheng123132/moneyswitch/issues/new?template=early-feedback.yml) with your setup, expected result, actual result and reproduction steps. A screenshot or redacted response is helpful when it explains the problem.

Never post a MoneyKey, approval PIN, administrator token, recovery phrase, or private key. Remove sensitive request URLs and personal information from public feedback. For a security vulnerability, follow the repository's [security reporting instructions](https://github.com/dongsheng123132/moneyswitch/blob/main/SECURITY.md) instead of publishing exploit details in an issue.

The question behind this trial is simple: does one wallet with separate spending permissions fit how you actually run your agents? Your experience will help us decide what to fix next.
