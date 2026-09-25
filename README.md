# MoneySwitch

[![License](https://img.shields.io/badge/license-AGPL--3.0%20%2F%20Apache--2.0-blue)](#license)
[![CI](https://github.com/dongsheng123132/moneyswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng123132/moneyswitch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/moneyswitch)](https://www.npmjs.com/package/moneyswitch)

**Give your AI an API key for money.**

[中文说明 →](README.zh-CN.md)

An AI agent holds a `mk_live_xxx` **MoneyKey** — not a wallet private key —
and spends USDC through [x402](https://x402.org)-priced HTTP APIs on the
[Monad](https://monad.xyz) testnet. MoneySwitch checks policy (budgets,
per-request limits, an approval threshold, a host allowlist, an SSRF guard)
*before* every payment, then signs the USDC authorization itself with a
locally-held, low-balance wallet. **The agent never sees the private key.**

<!-- screenshot: dashboard-overview -->

## Why

The industry already taught AI agents one pattern: hold a string that starts
with a prefix (`sk-…`, `mk_live_…`), put it in an `Authorization` header,
and the rest is handled for you. MoneySwitch reuses exactly that pattern for
money instead of inventing a new one — no wallet extension, no seed phrase,
no signing UI for the agent to click through. The agent calls an HTTP API
with a bearer token; MoneySwitch is the thing standing between that token
and an on-chain USDC transfer, enforcing the same kind of limits an
API-key-issuing platform already enforces on rate and spend.

## 30 seconds

Point an existing MoneySwitch server + MoneyKey at your local Claude Code /
Codex:

```bash
npx moneyswitch connect --server http://127.0.0.1:4020 --key mk_live_xxx --apply
```

This detects Claude Code / Codex on your machine and wires up the
MoneySwitch MCP server for you (dry-run by default — drop `--apply` first
to see what it would do). `npx moneyswitch status --server ... --key ...`
checks a MoneyKey's remaining budget; `npx moneyswitch remove --apply`
undoes it.

To self-host the server:

```bash
pnpm install
pnpm build
pnpm demo:local
```

`pnpm demo:local` starts a mock x402 facilitator, a demo x402 seller, and
the MoneySwitch server (with the Dashboard UI) together, entirely offline —
no real payment happens. See [`docs/quickstart.md`](docs/quickstart.md) for
the real Monad-testnet path (`pnpm demo:testnet`) and the manual
step-by-step version.

## Architecture

```text
                      mk_live_xxx (MoneyKey, not a private key)
                              │
   ┌──────────────┐   MCP / OpenAI-compatible / REST   ┌────────────────────┐
   │  AI Agent     │ ───────────────────────────────►  │  MoneySwitch server │
   │ (Claude Code, │                                    │  (apps/server)      │
   │  Codex, ...)  │ ◄─────────────────────────────── │  policy → wallet     │
   └──────────────┘        result / usage / error       │  (apps/dashboard)   │
                                                          └─────────┬──────────┘
                                                                    │ x402 (EIP-3009 USDC auth)
                                                                    ▼
                                                          ┌────────────────────┐
                                                          │   x402 facilitator  │
                                                          │  (settles on-chain) │
                                                          └─────────┬──────────┘
                                                                    ▼
                                                          ┌────────────────────┐
                                                          │   Monad testnet     │
                                                          │  USDC Transfer      │
                                                          └─────────┬──────────┘
                                                                    ▼
                                                          ┌────────────────────┐
                                                          │  x402 seller /      │
                                                          │  priced API         │
                                                          └────────────────────┘
```

The server holds the private key in an encrypted, low-balance local wallet
(`packages/wallet`); the agent process never has it. Every payment is
checked against policy (`packages/core`) inside a database transaction
*before* a signature is produced.

## Three ways to plug an agent in

1. **MCP** (`apps/mcp`, stdio) — `money_status`, `paid_fetch`,
   `money_history` tools. `npx moneyswitch mcp`, or `moneyswitch connect
   --apply` wires it into Claude Code / Codex automatically. See
   [`docs/claude.md`](docs/claude.md), [`docs/codex.md`](docs/codex.md).
2. **OpenAI / NewAPI-compatible gateway** — set `Base URL =
   http://<server>/v1`, `API Key = mk_live_xxx` in any OpenAI-SDK-compatible
   client (openai SDK, Cherry Studio, Open WebUI, NewAPI upstream channel).
   `GET /v1/models`, `POST /v1/chat/completions`, and the legacy OpenAI
   billing endpoints are implemented — see [`SPEC-v0.2.md`](SPEC-v0.2.md)
   and [`docs/money-api-v0.md`](docs/money-api-v0.md).
3. **REST** — `POST /v1/fetch { url, method?, headers?, body?, max_price? }`
   fetches any x402-priced URL through the policy engine directly. See
   [`docs/money-api-v0.md`](docs/money-api-v0.md).

## Roles

| Role | Holds | Uses | Can do |
|---|---|---|---|
| Admin (owner / finance) | `ms_admin_…` | Dashboard | wallet, channels, issue/revoke MoneyKeys, approve payments, see all usage |
| Employee | one or more `mk_live_…` | Dashboard "My Budget" view + desktop CLI | see own budget/history, Playground, one-command connect to their own local agent; cannot see others, cannot touch the wallet |
| Agent (Claude Code / Codex / Cherry Studio / …) | `mk_live_…` in env or MCP config | MCP or OpenAI-compatible interface | spend money, bounded by policy |
| Seller | no MoneySwitch account needed | x402 | receive USDC |

## Security model & guardrails

- **The agent never holds a private key.** Only a `mk_live_…` MoneyKey,
  scoped by budgets/allowlist/approval — the same shape as any other API
  key an agent already knows how to use.
- **Policy runs before signing**, inside one database transaction: per-request
  limit → `max_price` cap → daily/total budget → approval threshold. Nothing
  is signed until every check passes.
- **Host allowlist governs every outbound request**, including free ones —
  `POST /v1/fetch` is fundamentally an outbound proxy. An empty allowlist
  denies everything.
- **SSRF guard**: MoneySwitch always refuses to let an agent point it back
  at its own listening address, in any common literal form
  (`127.0.0.1`/`localhost`/`0.0.0.0`/`::1`). This is literal/hostname
  matching, not a DNS-rebinding defense — see
  [SECURITY.md](SECURITY.md) for the exact limitation.
- **Secrets never round-trip.** The full MoneyKey and admin token are shown
  exactly once, at creation; only their SHA-256 hash is stored. The wallet
  private key exists decrypted only in-process memory while unlocked, never
  on disk, never logged, never returned by any API response.
- **`unknown` payment outcomes count as spent**, conservatively, rather than
  risk silently exceeding a budget when an upstream result can't be
  determined (timeout, dropped connection). Audit them manually via
  `GET /v1/admin/usage`.

Full threat model: [`docs/security.md`](docs/security.md) /
[`SECURITY.md`](SECURITY.md).

## Monad testnet

MoneySwitch's x402 client and mock-facilitator test suite are built against
these testnet facts, checked against a live RPC as part of the repo's own
`pnpm test:testnet` (see [`SPEC.md`](SPEC.md) §1 for the full, dated table):

| | Value |
|---|---|
| CAIP-2 network | `eip155:10143` |
| RPC | `https://testnet-rpc.monad.xyz` |
| USDC (testnet) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` (6 decimals) |
| Facilitator | `https://x402-facilitator.molandak.org` |
| Payment scheme | `exact` (EIP-3009 `transferWithAuthorization`) |

A real settlement (no mock) is a `paid_fetch`/`/v1/fetch` call that produces
a `tx_hash`, independently checkable by fetching that transaction's receipt
and finding a matching USDC `Transfer(from=wallet, to=seller, value=…)` log
— see `tools/m6/verify-transfer.mjs`. MoneySwitch never auto-funds a wallet
or auto-requests testnet tokens; that's always a manual, out-of-band step
(see [`docs/quickstart.md`](docs/quickstart.md)).

As of 2026-09-26, 11 real (non-mock) x402 payments have been settled on the
Monad testnet this way — paid fetches, OpenAI-SDK chat completions and an
approval-gated payment — all visible on-chain; 4 of them (first payment,
Claude Code via MCP, OpenAI SDK chat, approval-gated) were checked
Transfer-by-Transfer with [`tools/m6/verify-transfer.mjs`](tools/m6/verify-transfer.mjs). All were gas-free for the agent's wallet (the facilitator relays and pays
gas for `exact`/EIP-3009 settlement), first tx `0x1c83a45d…4d4d` (block
65595248).

## Roadmap

- **v0.1** (done): MoneyKey, policy engine, local wallet, x402 client,
  MCP, Dashboard, offline (T1/T2) and testnet-read (T3) test suites.
- **v0.2** (done): OpenAI/NewAPI-compatible gateway (`/v1/chat/completions`,
  `/v1/models`, billing endpoints), channels, Playground.
- **v0.3** (current): employee-facing Dashboard view, one-command desktop
  connect (`moneyswitch-connect` → the `moneyswitch` npm package).
- **Next**: per-token pricing (x402 `upto`), MetaMask / OKX wallet drivers,
  multi-user organizations with department budgets and approval flows.
- Not planned (see [`SPEC.md`](SPEC.md) §12 for the full list and why):
  wallet-extension import, mainnet-by-default, fiat on-ramp.

## License

MoneySwitch is dual-licensed by component: the parts an agent or seller
*embeds in their own process* are permissive; the self-hosted server stays
copyleft so that hosted forks give improvements back.

| Component | License |
|---|---|
| `apps/mcp`, `apps/connect`, `apps/cli` (the `moneyswitch` npm package) — client-side code | [Apache-2.0](apps/mcp/LICENSE) |
| `apps/demo-seller` (x402 seller example) | [Apache-2.0](apps/demo-seller/LICENSE) |
| Everything else (`apps/server`, `apps/dashboard`, `packages/*`) | [AGPL-3.0-only](LICENSE) |

To embed the server in a closed-source product, open an issue to discuss a
commercial license.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require agreeing to
[CLA.md](CLA.md) (so the project can keep offering the dual-license terms
above). Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first.
