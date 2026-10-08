# A programmable Web3 cloud wallet for AI bots

An AI bot can write code, deploy a service and decide which API might answer a question. When that API asks for payment, what permission should the bot have?

“Give it a wallet” leaves a lot unanswered. How much can it spend today? Which services can it pay? When should it ask a person? How do you stop one bot without shutting down every other bot you run?

These are the questions behind **MoneySwitch: a programmable Web3 cloud wallet for AI bots that you host and control.** We are building it in the open, and we would like you to help shape it through real use, clear bug reports and pull requests.

![MoneySwitch: a self-hosted Web3 cloud wallet gives separate spending permissions to AI bots across devices.](https://moneyswitch.dev/assets/img/cloud-wallet-2026-10/cover-en.webp)

## Give the bot spending permission

Imagine a research agent finding a paid data endpoint. You want it to buy the data if the price fits its budget. You also want a coding agent on your laptop to have a different budget, and a background agent on your server to stop spending when its work ends.

MoneySwitch puts the wallet in one service and gives each agent a separate **MoneyKey**. A key authorizes spending requests under a policy; it does not contain the wallet's private key. One payer funds the wallet, while each agent has its own permission and limits.

The service checks daily and total budgets, a per-payment cap, allowed hosts and an approval threshold before signing a payment. A payment at or above the approval threshold waits for a person. A hard spending cap still applies after approval. Revoke a key and that agent's future requests are refused, while the other agents retain their own permissions.

That is what we mean by programmable: the rules are enforced by the service that signs the payment. They are more than instructions asking a model to be careful. A key's budget is a spending ceiling, not a separate funded balance.

## “Cloud wallet” means a service you run

Your agents might run in Codex on a laptop, Claude Code on a desktop, or a custom process in the cloud. They can reach the same MoneySwitch service through HTTP and the skill instructions generated for each key.

The cloud part is where you choose to run that service. You deploy it on infrastructure you control, keep its data, and manage the wallet. The current product is early self-hosted software: one instance spends for one payer, such as you or your organization. There is no MoneySwitch account where different customers deposit their funds.

The server is a trusted part of this setup. It holds a hot wallet and can sign payments. Keeping the private key off agent machines does not protect against a compromised wallet server. Separate the service's system permissions from the agents: an agent that can edit its database or wallet files can undermine the spending rules.

## What Web3 means here

Today the payment path is **USDC over x402**, with support for Monad and Base and testnets enabled by default.

An agent requests an API through MoneySwitch. A compatible seller responds with an HTTP 402 payment requirement. MoneySwitch checks the key's policy, obtains human approval if needed, signs an allowed payment, and retries with payment authorization. The agent receives the response and payment status.

The seller must accept a supported chain and payment scheme, and the wallet needs a balance on that chain. This does not make every website payable, support every blockchain, or buy a Claude or Codex subscription. The bots are callers of the wallet; their model provider's billing remains separate.

When a payment settles, a bill can show the key, amount, URL, chain and transaction hash. Responses distinguish `charged: yes`, `no` and `maybe`. An uncertain result needs investigation, not an automatic retry that might pay twice. These details matter as much as the successful payment: a bot's operator needs to know what happened.

## Help build the wallet your bots actually need

We want this product to be shaped by developers running their own bots. A useful contribution can start with something small:

- **Fix a deployment instruction.** If a step fails or assumes knowledge the guide never explains, reproduce the problem and propose a clearer instruction.
- **Make a failure reproducible.** Describe the expected result, actual result and a minimal testnet example. A failing test or a focused fix is even more useful when you can provide one.
- **Improve an agent connection.** Try the generated skill and HTTP flow with your own agent. Show where setup or error handling was confusing, then propose an example or documentation change that another developer can use.
- **Make a payment decision clearer.** If an approval or bill leaves you unsure what will happen, bring that specific situation into the discussion before proposing a new feature.

You do not need to build a large integration to contribute. A small pull request that removes a real obstacle gives us something concrete to review. For changes to payment behavior or permissions, start by discussing the scope so the implementation and its tests can follow an agreed boundary.

## Start with test coins and one complete workflow

The trial uses two agent keys, each making one payment of 0.01 test USDC on Monad testnet. One key can pay within its policy; the other asks for approval. You then inspect the bills and revoke a key to check that future requests stop. Test USDC has no monetary value.

Follow the trial guide for the exact setup and generated first-payment flow. If deployment or connection fails, report that step; a successful payment is not a prerequisite for useful feedback. Share only redacted details, never keys, approval PINs, recovery phrases or administrator credentials.

We may offer rewards at our discretion based on trial participation and feedback. Submitting or merging a pull request does not automatically qualify for a reward.

**[Help build a Web3 cloud wallet for AI bots — read the contribution guide and submit a PR](https://moneyswitch.dev/contribute/).** If you want to try it first, [start the two-agent testnet trial](https://moneyswitch.dev/pilot/).

We have an initial implementation. The next useful step is to put it beside the bots you already run, find the missing pieces, and improve them together.
