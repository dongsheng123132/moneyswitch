## What does this PR do?

<!-- One or two sentences. Link the issue this addresses, if any. -->

## Which component(s)?

<!-- apps/server, apps/dashboard, apps/server-pkg (moneyswitch-server npm package), packages/*, docs -->

## Spec impact

<!-- Does this change documented behavior in SPEC.md, or add an external
route (which must also be added to the route inventory test)? If yes, SPEC.md
is changed first and this PR contains that change. If no, say "none". -->

## Testing

<!-- What did you run, and what was the result? Paste the tail of the
relevant `pnpm test` / `pnpm test:e2e` output. New behavior needs a new
test in the same PR — see CONTRIBUTING.md's T1/T2/T3 section. -->

- [ ] `pnpm test` passes locally
- [ ] `pnpm test:e2e` passes locally (if this touches payment/x402 logic)
- [ ] Added/updated tests for the new behavior
- [ ] Updated `SPEC.md` first, and the route inventory test for a new route (or N/A)
- [ ] No secrets, `.env` files, or real private keys included in the diff

## CLA

- [ ] I have read and agree to [CLA.md](../CLA.md)
