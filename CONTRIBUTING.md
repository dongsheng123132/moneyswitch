# Contributing to MoneySwitch

MoneySwitch is a programmable Web3 cloud wallet for AI bots, self-hosted
on the payer's own server. Documentation fixes, clearer agent integration
instructions, bug reports and focused code improvements are welcome.
It can move real USDC on mainnet, so payment correctness and security
review matter. Read the relevant requirements below before opening a PR.

## First PR

Read the step-by-step website guide in
[English](https://moneyswitch.dev/contribute/) or
[中文](https://moneyswitch.dev/contribute/zh/). No login is needed to read
the guide; GitHub requires an account when you fork or submit an issue or PR.

1. Choose one small problem. A typo, broken link or clear documentation
   correction can go straight to a PR. For a substantial change, first
   [propose it in an issue](https://github.com/dongsheng123132/moneyswitch/issues/new?template=contribution_proposal.yml).
   Deployment and payment behavior changes must follow `SPEC.md`.
2. [Fork this repository](https://github.com/dongsheng123132/moneyswitch/fork).
   Clone **your own fork**, replacing `YOUR_GITHUB_USER` below with your
   GitHub username, and create a branch:

   ```bash
   git clone https://github.com/YOUR_GITHUB_USER/moneyswitch.git
   cd moneyswitch
   git remote add upstream https://github.com/dongsheng123132/moneyswitch.git
   git switch -c docs/my-first-fix
   ```

3. Edit the source files, review the diff, and follow the existing test
   requirements below. For site changes, also preview both languages and
   a phone-sized viewport. Record what you actually verified.
4. Commit only the intended files and push the branch to your fork:

   ```bash
   git diff
   git add path/to/changed-file
   git commit -m "docs: clarify the trial setup"
   git push -u origin docs/my-first-fix
   ```

   Replace the example file path and commit message with your actual change.
5. Open the [upstream comparison](https://github.com/dongsheng123132/moneyswitch/compare)
   and choose **compare across forks**. The base repository is
   `dongsheng123132/moneyswitch`, **base: main**. The head repository is
   your fork; the compare branch is your branch. Explain the change and
   verification, personally read the CLA, then check its agreement box
   if you agree. Opening a PR starts review; it does not approve the change.

For a small edit to the Chinese trial page, the
[GitHub editor](https://github.com/dongsheng123132/moneyswitch/edit/main/site/pilot/zh/index.html)
can guide you through a fork and proposed change. A clear
[trial report](https://github.com/dongsheng123132/moneyswitch/issues/new?template=early-feedback.yml)
is useful even if you do not have a fix.

### Website and blog source files

| Content | Edit here | Generated output |
| --- | --- | --- |
| Homepage | `site/index.html`, `site/assets/js/i18n.js`, `site/assets/css/site.css` | None; maintain English and Chinese together |
| Trial and contribution guides | `site/pilot/`, `site/contribute/`, their styles in `site/assets/css/` | None; keep both language pages consistent |
| Blog articles | `docs/blog/<slug>.md` and `docs/blog/<slug>.zh.md` | `site/blog/` |
| Blog dates, search descriptions and article registration | `scripts/build-blog.mjs` | Blog indexes and article metadata |

After changing blog sources or their manifest, run:

```bash
node scripts/build-blog.mjs
```

Include the relevant generated output in your PR. Do not edit generated
`site/blog/` HTML alone: the next build would overwrite it. Do not replace
published transaction hashes or claim a feature exists without checking it.

Rewards may be offered at the maintainers' discretion based on participation
and feedback, with details announced separately. Submitting or merging a PR
does not guarantee a reward or a fixed amount.

## Before you start

- **Contributions require agreeing to the [CLA](CLA.md)** (see below —
  it's short). The CLA is what lets the project keep offering the
  dual-license terms in the [README](README.md#license). Read and agree
  personally; no guide or automated tool checks that box on your behalf.
- For anything non-trivial, open an issue first describing what you want to
  change and why, so it can be discussed before you spend time on an
  implementation that might not fit the spec (`SPEC.md` is the only
  authoritative spec; older versions are kept in `docs/archive/` for history
  only. When in doubt, `SPEC.md` wins over this file).
- **Out of scope, closed without review:** user sign-up or accounts, per-user
  balances, deposits or withdrawals, payment or top-up integrations,
  redemption codes, resale with a markup. One MoneySwitch spends for one
  payer (`SPEC.md` §0); holding or spending other people's money is custody
  (`SPEC.md` §8).
- Security issues: see [SECURITY.md](SECURITY.md) — do **not** open a
  public issue for a vulnerability.

## Development environment

```bash
git clone https://github.com/dongsheng123132/moneyswitch.git
cd moneyswitch
pnpm install
pnpm build
```

Requirements: Node.js 22+ (`.nvmrc` pins the LTS used in CI), pnpm 10 (see
`packageManager` in `package.json`).

Useful commands:

```bash
pnpm build              # build every workspace package, in dependency order
pnpm test                # T1: offline unit/integration tests, must be green
pnpm test:e2e             # T2: offline end-to-end (mock-facilitator)
pnpm test:testnet         # T3: read-only checks against live Monad testnet RPC
pnpm demo:testnet         # test seller + server against the real Monad testnet facilitator (needs a funded wallet)
pnpm dev:server           # apps/server in watch mode
pnpm dev:seller           # apps/demo-seller in watch mode
```

Per-package commands: `pnpm --filter <package-name> <script>`, e.g.
`pnpm --filter @moneyswitch/core test`.

## Test layers (T1/T2/T3)

MoneySwitch's test suite is deliberately split into three layers with
different network/fund requirements:

- **T1 — offline unit/integration** (`pnpm test`): no network access, no
  funds, must be fully green before every PR. Covers policy DENY/ALLOW/
  PENDING decisions, concurrency, SSRF blocking, secret redaction, and each
  package's own unit tests.
- **T2 — offline end-to-end** (`pnpm test:e2e`): still no real network —
  `mock-facilitator` does real EIP-3009 signature verification (via viem)
  but settles with a fake tx hash. Exercises the full /v1/fetch → server →
  demo-seller → 402 → sign → verify → settle → 200 chain offline.
- **T3 — testnet read-only checks** (`pnpm test:testnet`): the funds-free
  parts (RPC chain ID, USDC contract metadata) run by default whenever
  there's network access. The funds-requiring parts (an actual on-chain
  settlement) are gated behind `MONEYSWITCH_E2E_TESTNET=1` and require a
  funded wallet — **do not** run these against the maintainers' shared
  testnet instances; use your own funded wallet if you need to exercise
  this layer.

A PR only needs T1 (and T2 if you touched payment/x402 logic) to be green
locally; CI runs T1 + T2 on every PR (see `.github/workflows/ci.yml`). T3's
funds-requiring half is never run in CI.

## Commit / PR conventions

- Commit messages: short imperative summary line (`fix: ...`, `feat: ...`,
  `docs: ...`), a body only if the "why" isn't obvious from the diff.
- One logical change per PR. Don't mix a refactor with a new feature
  (`SPEC.md` §9: one branch does one thing).
- Change `SPEC.md` **first** if you're changing documented behavior or adding
  an external route — the spec is the source of truth, not the code. Every
  external route is listed in `apps/server/test/unit/route-inventory.test.ts`;
  a route that is not in that list fails the test.
- New behavior needs new T1 (and T2 where relevant) tests in the same PR;
  a PR that changes payment/policy logic without a matching test will be
  asked to add one before review.
- Never commit secrets, `.env` files, real testnet private keys, or
  anything under `.data/`.

## Code style

- TypeScript, `strict: true` (see `tsconfig.base.json`). No implicit `any`.
- No floating-point arithmetic on money — amounts are integer micro-USDC
  internally, decimal strings at API boundaries (see
  `packages/core/src/money.ts`).
- Prefer small, pure, unit-testable functions in `packages/core` over logic
  embedded in route handlers.

## License of your contribution

By submitting a contribution you agree it's licensed under the same terms
as the file(s) you changed (AGPL-3.0-only for `apps/server`,
`apps/dashboard`, `packages/*`; Apache-2.0 for `apps/demo-seller`,
`apps/qwen-agent`), and you grant the maintainers the
re-licensing rights described in [CLA.md](CLA.md).
