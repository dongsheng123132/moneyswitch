# Colosseum project progress — 2026-10-12

Project: <https://colosseum.com/arena/projects/moneyswitch>

Status: **Project description saved and Builder Update published; formal project submission is pending the final survey.** The user authorized operating their logged-in Chrome session. The saved description was independently checked on the public project page. The published update is <https://colosseum.com/arena/projects/moneyswitch/updates/1795>; its complete text and Looking for testers tag were checked after publication. The review page reports Ready to submit. The mandatory final survey is awaiting the user's confirmation of personal experience and feedback answers; no final submission receipt has been obtained yet.

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

Start with testnet and a limited MoneyKey using the self-hosting instructions.

## Private maintenance evidence — do not paste into the public form

- Current local HEAD before this wording update: `be654cf`; working tree was clean. The preceding deployment-evidence HEAD was `aa2e05a`.
- The user confirmed in this turn that they attended the Shenzhen offline hackathon activity and that their Monad entry was officially submitted. These facts come from the user; no Monad platform receipt was independently inspected. Monad submission does not establish a Colosseum submission.
- The user authorized updating the Colosseum project description and progress, followed by formal project submission, and subsequently explicitly authorized operating the opened Chrome Colosseum page. The alternate TinyFish login path was not used. The available cua-driver browser route connected under standard permission mode to the exact authorized Chrome window, without copying a browser profile or reading credentials.
- Read-only live verification on October 12: image `moneyswitch:54f2981`, container `healthy`, public `/healthz` returned `{"ok":true}`.
- Deployment validation: [Solana mainnet activation](2026-10-12-solana-mainnet-payments.md). This supersedes the earlier read-only mainnet-balance deployment.
- Test payment evidence: [Solana Devnet integration](../solana-devnet.md) and the linked Base/Solana receipts. These payments occurred on October 11, not during today's activation.
- The October 11 Demo Day deck remains a historical snapshot. Its Solana-mainnet-disabled text predates today's opt-in activation; its sidebar shortcut has been removed. The new public update deliberately does not present that deck as the current mainnet status.
- The public project description now matches Public description above. Four adjacent project fields were also brought up to date: product audience text lists Solana/Base/Monad; technology text includes Solana; chain-use text states today's explicit mainnet opt-in and unverified mainnet seller settlement; judge context includes the user's confirmed Demo Day participation and Monad submission. Each field was read back before Save and review, then checked on the saved review page. The original field values are retained in an ignored local backup. The personal bio was not edited.
- The saved review page has the existing technical-demo link `https://youtu.be/ZVdWpXmK7Bw` and pitch link `https://youtu.be/rmIZVpBbtU8`, an existing complete submission profile, and Ready to submit. The technical video remains hidden from the public project page as previously configured. No accelerator application was added. Existing media, contact and personal-profile fields were preserved.
- Builder Update 1795 was published once, with 2,185 characters of plain rich-editor text, no images and Looking for testers enabled. Markdown links in the draft were rendered as plain labels and URLs. The post's full paragraphs were independently read back on its saved detail page. The platform now shows the daily update limit used; do not publish a second copy.
- The final survey requires first-awareness source, motivation, ranked chain-choice reasons, prior chain experience, development difficulty, future chain use, helpful event features, overall experience, continued-project intent and next-step needs. Personal answers are not inferred as verified facts. A proposed neutral answer set has been sent for the user's confirmation before final submission.
- No new payment, administrator-token reset or wallet modification occurred during this publication task.
