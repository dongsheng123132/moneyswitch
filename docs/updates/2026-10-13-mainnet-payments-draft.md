# October 13 mainnet update — user submission draft

Status: **Draft only. Prepared for the user to submit manually.** Suggested status: **On track**. This draft supersedes the unposted mainnet-settlement-pending candidate in `2026-10-13-colosseum-submission.md`; historical published updates are unchanged.

## Copy into Update

Mainnet x402 payments verified on Solana, Base and Monad

MoneySwitch is an open-source, self-hosted programmable Web3 cloud wallet for AI bots. We have now verified real USDC x402 payments across three mainnets:

- Solana: 0.01 USDC to CoinGecko, with finalized settlement.
- Base: 0.01 USDC to CoinGecko and 0.001 USDC to Quicknode, returning market data and an RPC result.
- Monad: 0.20 USDC to AgentVerse to purchase two cells.

These checks covered both automatic payments below the approval threshold and payments requiring human approval. Approval links now open the confirmation-code form even when the owner is already signed in, and new approvals remain valid for 30 minutes.

Each agent receives a revocable MoneyKey with per-request, daily and total budgets, allowed service domains and an approval threshold. Wallet signing stays on the owner's server. Bills keep confirmed payments separate from payments awaiting reconciliation, and mainnet spending separate from testnet activity.

We also deployed a Solana USDC x402 payment option to our AgentVerse demo merchant, alongside Base and Monad.

Next: publish verified endpoint compatibility and simplify the first-payment experience. We welcome Solana x402 sellers and agent developers to test the flow and share feedback.

Source: https://github.com/dongsheng123132/moneyswitch
Website: https://moneyswitch.dev

## Optional evidence links / Add details

Solana / CoinGecko / 0.01 USDC:
https://solscan.io/tx/PwwnmH9fBXwgFZJhNfrHXHGJ6nN27TLBgTJTf6PhEnaBeco7CC9CKtRQGau2QfSH3bPr7P2mmLJbyjDePW74YWg

Base / CoinGecko / 0.01 USDC:
https://basescan.org/tx/0xd77ef3e9059e3f649d21dc2abbece5448ec6662235436d40882ec2cf10d824f1

Base / Quicknode / 0.001 USDC:
https://basescan.org/tx/0x718dff364c385656a1ddfdcec4473aa8801ae5bb715485fed0b62282875671cf

Monad / AgentVerse / 0.20 USDC:
https://monadvision.com/tx/0xfb6db2eccac26143f38cdf7abc07fdfc5bd7df2ab1f669fa3edc07067e57baad

## Maintenance evidence — not part of the public post

- Solana transaction was independently read with finalized commitment: slot 456290255, meta.err null, canonical USDC balance deltas -10000 and +10000 to CoinGecko's receiver.
- Base receipts both returned status 0x1. Canonical Base USDC transferred 10000 units to CoinGecko and 1000 units to Quicknode. The current MoneyKey history lists both settled without an error.
- Monad receipt returned status 0x1, block 112941021, canonical USDC transfer of 200000 units to the AgentVerse receiver; the prior delivered merchant receipt records the two purchased cells.
- The new confirmation-code Key spent 0.011 USDC in this round, leaving 0.089 today and 0.989 total. Its subsequent Solana price request returned charged=no and no payment; that free response is not a new settlement. The public Solana claim uses the separately verified earlier CoinGecko payment.
- MoneySwitch production runs d4a1487 after backup and health checks. New approval links contain mode=pin; the public skill and frontend state 30 minutes. Owner wallet file hashes remained unchanged.
- AgentVerse production was fast-forwarded to dc45950. Its production purchase quote advertises Solana canonical USDC and the user's receiver, alongside Base/Monad; x402_unavailable_networks is empty. A paid Solana purchase at this merchant has not been completed with the new Key because its 0.02 USDC per-request limit is below the 0.10 USDC purchase price. The draft does not claim that merchant settlement was tested on Solana.
- These are development checks, not customer adoption or transaction volume. No user count, revenue, safety superiority or complete provider compatibility is claimed.
- No new payment or external post was performed while preparing this draft.
