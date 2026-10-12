# Colosseum project progress — 2026-10-12

Project: <https://colosseum.com/arena/projects/moneyswitch>

Status: **Prepared, not published or formally submitted on Colosseum.** No Colosseum publication or submission receipt has been obtained. Earlier local browser control and the Computer Use runtime failed to start; the available alternate browser profile has no recorded Colosseum sign-in. A local fallback sign-in page has been sent to the user, and their sign-in is pending. Verify the saved update and formal project submission separately before changing this status.

## Public title

Solana, Base and Monad: Demo Day progress and controlled agent spending

## Public description

MoneySwitch is a self-hosted spending gateway for AI agents on Solana, Base and Monad. Each agent gets a revocable MoneyKey with budgets, allowed domains and human approvals; wallet signing keys stay on the owner's server. Solana mainnet payments require explicit opt-in; real mainnet seller settlement has not yet been verified.

## Public post

MoneySwitch supports Solana, Base and Monad as a self-hosted spending gateway for AI agents. Its latest build is deployed on our US server. Each agent receives a revocable MoneyKey with spending limits, allowed service domains and human approval rules; wallet signing keys stay on the owner's server.

We attended Shenzhen's offline hackathon Demo Day and have officially submitted our Monad entry. We also created a five-minute browser presentation and a local interactive simulation for the event. The product now shows MoneyKeys as budget cards with usage meters, search and filters. Bills separate mainnet and testnet totals, flag payments awaiting reconciliation, and show request, recipient and chain transaction details on demand.

On October 11, we completed **0.01 test-USDC payments on both [Base Sepolia](https://sepolia.basescan.org/tx/0x095a04dec1dbcc55e87c96abb69b0c0312a0c2606d5a3f8fa635deb71c7ea633) and [Solana Devnet](https://explorer.solana.com/tx/3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu?cluster=devnet)**, with independent chain verification including finalized Solana settlement. Test tokens have no monetary value.

On October 12, we deployed **explicit opt-in Solana mainnet USDC payment support**, alongside a separate mainnet balance view. Mainnet and testnet MoneyKeys retain their network restrictions. Policy and transaction-construction checks passed; **a real mainnet seller-settlement test remains outstanding**. No real payment was sent during activation.

Requests can pin a payment network instead of silently falling back to another chain. Optional purpose notes help review spending without requiring full task prompts; notes are self-reported, and hiding them is a display choice rather than access control.

Feedback on key setup, budgets, approvals, network selection and billing is welcome. [Source and self-hosting instructions](https://github.com/dongsheng123132/moneyswitch) · [Demo instance](https://app.moneyswitch.dev/keys) (administrator sign-in required).

## Private maintenance evidence — do not paste into the public form

- Current local HEAD before this wording update: `be654cf`; working tree was clean. The preceding deployment-evidence HEAD was `aa2e05a`.
- The user confirmed in this turn that they attended the Shenzhen offline hackathon activity and that their Monad entry was officially submitted. These facts come from the user; no Monad platform receipt was independently inspected. Monad submission does not establish a Colosseum submission.
- The user authorized updating the Colosseum project description and progress, followed by formal project submission. A local fallback Colosseum sign-in page has been sent, and user sign-in is pending. Authorization is not a publication or submission receipt.
- Read-only live verification on October 12: image `moneyswitch:54f2981`, container `healthy`, public `/healthz` returned `{"ok":true}`.
- Deployment validation: [Solana mainnet activation](2026-10-12-solana-mainnet-payments.md). This supersedes the earlier read-only mainnet-balance deployment.
- Test payment evidence: [Solana Devnet integration](../solana-devnet.md) and the linked Base/Solana receipts. These payments occurred on October 11, not during today's activation.
- The October 11 Demo Day deck remains a historical snapshot. Its Solana-mainnet-disabled text predates today's opt-in activation; its sidebar shortcut has been removed. The new public update deliberately does not present that deck as the current mainnet status.
- Latest read-only public-page verification on October 12 found that the project description and the owner's `hecare` profile bio still mention Monad/Base. The intended description update applies only to the project; the personal bio is outside this task's confirmed scope.
- The observed public project fields are `submittedAt: null`, pitch link `https://youtu.be/rmIZVpBbtU8`, and an empty `technicalDemoLink`. These fields are verification checkpoints, not proof of signed-in edit access or a completed formal submission. Do not mark the project submitted until a saved submission result is verified.
- No new payment, administrator-token reset, wallet modification or external post was performed while preparing this update.
