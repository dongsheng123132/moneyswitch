# Colosseum project progress — 2026-10-12

Project: <https://colosseum.com/arena/projects/moneyswitch>

Status: **Prepared, not published.** No platform submission receipt has been obtained. Local browser control and the Computer Use runtime failed to start; the available TinyFish profile has no recorded Colosseum sign-in. A request for the user to sign in through the alternate browser is pending. Do not mark this published without checking the saved update on Colosseum.

## Public title

Solana mainnet opt-in, verified test payments, and clearer agent spending

## Public post

MoneySwitch's latest build is deployed on our US server. Each AI bot receives a revocable MoneyKey with spending limits, allowed service domains and human approval rules; wallet signing keys stay on the owner's server.

For Shenzhen's offline hackathon Demo Day, we prepared a five-minute browser presentation and a local interactive simulation. The product now shows MoneyKeys as budget cards with usage meters, search and filters. Bills separate mainnet and testnet totals, flag payments awaiting reconciliation, and show request, recipient and chain transaction details on demand.

On October 11, we completed **0.01 test-USDC payments on both [Base Sepolia](https://sepolia.basescan.org/tx/0x095a04dec1dbcc55e87c96abb69b0c0312a0c2606d5a3f8fa635deb71c7ea633) and [Solana Devnet](https://explorer.solana.com/tx/3aBQPBbW2thr3k7WMv4UkFXcDgNDhfLvKv7QVLDFEcaR8PJYEMPmquZcf79bTt18RSz6s9TVdU3UvyL8NBxpQBCu?cluster=devnet)**, with independent chain verification including finalized Solana settlement. Test tokens have no monetary value.

On October 12, we deployed **explicit opt-in Solana mainnet USDC payment support**, alongside a separate mainnet balance view. Mainnet and testnet MoneyKeys retain their network restrictions. Policy and transaction-construction checks passed; **a real mainnet seller-settlement test remains outstanding**. No real payment was sent during activation.

Requests can pin a payment network instead of silently falling back to another chain. Optional purpose notes help review spending without requiring full task prompts; notes are self-reported, and hiding them is a display choice rather than access control.

Feedback on key setup, budgets, approvals, network selection and billing is welcome. [Source and self-hosting instructions](https://github.com/dongsheng123132/moneyswitch) · [Demo instance](https://app.moneyswitch.dev/keys) (administrator sign-in required).

## Private maintenance evidence — do not paste into the public form

- Current local HEAD before this draft: `aa2e05a`; working tree was clean.
- Read-only live verification on October 12: image `moneyswitch:54f2981`, container `healthy`, public `/healthz` returned `{"ok":true}`.
- Deployment validation: [Solana mainnet activation](2026-10-12-solana-mainnet-payments.md). This supersedes the earlier read-only mainnet-balance deployment.
- Test payment evidence: [Solana Devnet integration](../solana-devnet.md) and the linked Base/Solana receipts. These payments occurred on October 11, not during today's activation.
- The October 11 Demo Day deck remains a historical snapshot. Its Solana-mainnet-disabled text predates today's opt-in activation; its sidebar shortcut has been removed. The new public update deliberately does not present that deck as the current mainnet status.
- Public project HTML was retrieved without credentials on October 12. Its description mentions the Solana Devnet integration and PR #17, but that public response does not establish access to the owner's update form or a successful new post.
- No new payment, administrator-token reset, wallet modification or external post was performed while preparing this update.
