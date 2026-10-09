# One self-hosted spending wallet for agents across your computers

![MoneySwitch: many agents, one spending wallet. Product concept illustration.](https://moneyswitch.dev/assets/img/launch-2026-10/cover-en.webp)

You have Codex on a laptop, Claude Code on a desktop, and another agent working on a cloud server. Each can call tools and APIs. Sooner or later, one of those tools asks for payment.

Now you have a different problem: which agent can spend, how much, and who can stop it?

Setting up a separate wallet for each bot means managing balances, credentials and transaction history across machines. You may already use an interactive wallet such as MetaMask yourself, but you do not necessarily want to repeat that setup for every unattended agent.

That is the problem we are building MoneySwitch around: **a programmable spending wallet for multiple agents, self-hosted on a server you control.**

## One wallet, separate spending permissions

MoneySwitch runs as a service. You create its wallet, keep a small balance there, and issue a separate MoneyKey to each agent. A MoneyKey looks like an API key. It gives the holder permission to request payments within a policy; it does not contain the wallet's private key.

A setup might look like this:

| Agent | Where it runs | What it receives |
|---|---|---|
| Codex | Your laptop | A MoneyKey with its own budget and allowed hosts |
| Claude Code | Your desktop | A different MoneyKey with its own limits |
| A background agent | Your cloud server | Another MoneyKey that you can revoke independently |

All three send payment requests to your MoneySwitch service. You manage their spending permissions in one place. This works across machines through the HTTP interface and the instructions supplied with each key; it does not depend on installing a browser wallet on each machine.

The current product is **early self-hosted software**. One instance spends for one payer: you, or your organization. “Cloud wallet” here means a wallet service you can deploy on your own cloud server, with HTTPS and persistent storage. It is not an account where you deposit money with MoneySwitch.

## What “programmable” means today

Each key has a daily budget, a total budget, a per-payment cap, allowed hosts, an approval threshold and an expiry. The service checks the policy before signing a payment.

- A request within the limits, to an allowed host, and below the approval threshold can proceed automatically.
- A payment **at or above** the approval threshold pauses for a person. A request to a new public host also needs approval before MoneySwitch contacts it; approving that host adds it to this key's allowlist.
- A payment beyond a hard cap is rejected. Human approval does not override the daily, total or per-payment limit.
- You can revoke an individual key when its work is finished or its permission should end. Revocation blocks future requests; it does not undo an already signed or settled payment.

The person responsible for a key can open the approval link and enter that key's 4–6 digit confirmation PIN. A logged-in administrator can also approve or reject requests. Keep that PIN with the person, outside the agent's prompt and configuration.

The distinction matters: the agent asks to spend, the server enforces the limits, and a person handles the requests that need a decision.

## The payment path is x402

Today MoneySwitch pays compatible x402 APIs in USDC. An agent calls `POST /v1/fetch` with its MoneyKey and the API request. If the seller returns an HTTP 402 payment requirement, MoneySwitch checks the request against the key's policy, signs an allowed payment, and retries the request with the payment authorization.

Supported networks are Monad and Base, with testnets enabled by default. The seller has to accept a supported chain and payment scheme, and your wallet needs a balance on that chain. This is not a way to pay for every model API or an existing Claude, Codex or other subscription. Those agents are possible callers of the wallet; their subscription billing is a separate system.

We have published a [recorded Qwen and Nansen experiment](https://moneyswitch.dev/blog/qwen-agent-pays-nansen/) with five Monad mainnet transactions and a $0.09 budget. That is evidence for a specific payment flow. The wider question we want to test now is whether a shared wallet service makes day-to-day work with multiple agents easier.

## A bill should tell you what happened

The dashboard records the key, amount, requested URL, chain, transaction hash when available, and `charged: yes | no | maybe`. Mainnet and testnet amounts are kept separate.

That lets you inspect a payment and follow its chain transaction. It does not tell you whether the agent's purchase was useful, and it is not a task-level expense report. If the result is uncertain, an agent must not blindly retry and risk another payment.

We want feedback on that boundary too: is the current bill enough to understand the purchase, or do you still have to reconstruct too much from the agent's conversation?

## Self-hosting still has a trust boundary

The private key stays on the MoneySwitch server. The server must be able to sign unattended payments, so this is a **server-side hot wallet**. A compromised server can put its funds at risk; “the agent does not receive the private key” is not a promise that the wallet cannot be compromised.

Keep the service and the agents isolated by system permissions. An agent that can edit the server's database or wallet files can bypass the intended boundary. Use a separate server or properly isolated service, protect its administrative access, and keep only a small spending balance when you eventually use mainnet.

Start on testnet. Test USDC has no monetary value, and it is enough to check the payment, approval and revocation flows.

## Help us test the actual workflow

We are inviting developers who already run agents on more than one machine, or run multiple agents locally and in the cloud. Connect two agents, make a small testnet payment, try an approval, inspect the bill and revoke a key.

Then tell us where you got stuck and whether this is a wallet you would want to keep running. We are especially interested in the steps that still require you to act as the agent's manual payment operator.

**[Try MoneySwitch with two agents](https://moneyswitch.dev/pilot/)**. The trial page has the current setup path and feedback instructions. You can also read the [source and deployment documentation](https://github.com/dongsheng123132/moneyswitch) or [open a feedback issue](https://github.com/dongsheng123132/moneyswitch/issues/new?template=early-feedback.yml).
