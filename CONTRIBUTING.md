# Contributing to MoneySwitch

Thanks for considering a contribution. MoneySwitch moves real money (USDC
on a live testnet, and eventually mainnet), so correctness and security
review matter more here than in most projects — please read this whole
document before opening a PR.

## Before you start

- **Contributions require agreeing to the [CLA](CLA.md)** (see below —
  it's short). The CLA is what lets the project keep offering the
  dual-license terms in the [README](README.md#license).
- For anything non-trivial, open an issue first describing what you want to
  change and why, so it can be discussed before you spend time on an
  implementation that might not fit the spec (`SPEC.md` is the only
  authoritative spec; older versions are kept in `docs/archive/` for history
  only. When in doubt, `SPEC.md` wins over this file).
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
