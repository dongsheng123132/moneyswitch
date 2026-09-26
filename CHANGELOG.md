# Changelog

All notable changes to MoneySwitch are documented here. Dates are the day
each spec increment was implemented, per the repository's own `SPEC*.md`
files.

## 0.5.0 — 2026-09-26

Toll booths: let any API charge AI in USDC (`SPEC-v0.5.md`).

- **The three things** (private key / MoneyKey / receiving address) as one
  mental model across the product: an explainer card (wallet, toll booth,
  earnings and login pages), MoneyKeys always shown amber with a lock and
  "secret — never send it to a seller", receiving addresses always green
  with a share icon and "public — safe to share".
- **Guard rails**: pasting a MoneyKey / admin token / private key /
  recovery phrase into a receiving-address field is blocked, cleared and
  explained (Dashboard), refused by the API (`400 INVALID_PAY_TO` with a
  `reason`, the value is never echoed) and by `moneyswitch sell --pay-to`
  (exit 2); a `0x…` address pasted into a key field is blocked too (server:
  `KEY_INVALID` + `hint: LOOKS_LIKE_ADDRESS`). Addresses are EIP-55 checked
  and stored checksummed.
- **Toll booths** (`tollbooths`, `tollbooth_routes`, `earnings` tables;
  additive migration `0003_v05_tollbooths.sql`, upgrades a v0.4 database in
  place): public paid proxy `ANY /t/{slug}/*` built on the official x402 SDK
  (`@x402/core/server` + `@x402/evm`, testnet USDC money parser as in
  `apps/demo-seller`). Per-route prices (exact / prefix / wildcard, most
  specific wins, `0` = free), default price or refuse. The payment is
  verified, the request forwarded (no redirects, 30 s, 10 MB, buyer
  `Authorization`/`Cookie`/payment headers stripped, `X-MoneySwitch-Payer`
  / `-Amount` / `-Tollbooth` added), and **settled only if the upstream
  answered 2xx/3xx** — otherwise the buyer is not charged and the call is
  recorded as a failed earning with its upstream status.
- Admin API: `GET/POST /v1/admin/tollbooths`, `GET/PATCH/DELETE
  /v1/admin/tollbooths/:id`, rule CRUD, free upstream probe
  (`POST …/:id/test`, `POST …/test-upstream`), `GET /v1/admin/earnings`
  (today / 7d / all, totals, per toll booth / per rule); `GET
  /v1/admin/meta` adds `wallet_address` (default receiving address — one
  wallet receives and pays) and `public_base` (`MONEYSWITCH_PUBLIC_URL`).
- A MoneyKey may buy from a toll booth on the same server: the self-port
  SSRF rule has an exception for `/t/…` only. The self-target check now also
  covers `localhost.`, IPv4-mapped IPv6 and the machine's own interface
  addresses; toll booth upstreams are additionally checked after DNS
  resolution, on save and on every request.
- Dashboard: *Toll booths* (3-step wizard — which service / how to charge /
  where the money goes — with templates, live price preview, upstream test,
  completion page with the public address and buyer snippets), *Earnings*
  (today / 7 days / all, grouped, per-payment rows, CSV export), Overview
  *Earned today* next to *Spent today*, Wallet page split into *Receive* and
  *Pays from*, Playground *Paid request (x402)* mode (buy any x402 URL with
  a MoneyKey through `/v1/fetch`). All copy in English and Chinese.
- **`moneyswitch sell`** (`apps/cli`, Apache-2.0): a single-process toll
  booth without a MoneySwitch server, on the official `@x402/express`
  middleware, sharing rule matching, path normalization, forwarding and
  pay-to checks with the server through the new Apache-2.0
  `packages/tollbooth`.
- Tests: `packages/tollbooth` unit tests (rule matching, path-normalization
  bypasses, pay-to / key-field checks, header handling, self-target), core
  toll booth / earnings / migration tests, server + CLI unit tests, and the
  offline e2e `apps/server/test/e2e/tollbooth-flow.test.ts` (402 with the
  right `payTo`; MoneyKey purchase through `/v1/fetch`; upstream 500 → no
  facilitator `/settle`, no settled payment, failed earning; free route;
  disabled / refused paths; replay; `moneyswitch sell` end to end).

## 0.3.0 — 2026-09-25

Employee access + one-command desktop connect (`SPEC-v0.3-employee.md`).

- Dashboard: single-input login now auto-detects `ms_admin_` (admin
  console) vs `mk_live_` (employee view) prefixes.
- New employee Dashboard view: My Budget, Playground, History, Connect —
  scoped to the logged-in MoneyKey only (no Keys/Channels/Wallet/Approvals
  access).
- Admin "Send to employee" tab on MoneyKey creation: a ready-to-paste
  message with server address, key, employee-view URL, and the one-command
  connect string.
- New `apps/connect` package (`moneyswitch-connect`, Apache-2.0): detects
  Claude Code / Codex on the local machine and wires up the MoneySwitch MCP
  server for them (`connect`/`status`/`remove`, dry-run by default,
  `--apply` to make changes, `--json` for machine-readable output).
- `GET /v1/status` now returns `key_name`, `key_prefix`, `daily_budget`,
  `total_budget` in addition to the existing remaining-budget fields.
- New `apps/cli` package, published to npm as **`moneyswitch`**
  (Apache-2.0): bundles `apps/connect` + `apps/mcp` into a single
  dependency-free CLI (`npx moneyswitch connect|status|remove|mcp`).
  When run from the published package (no `@moneyswitch/mcp` workspace
  package to resolve), `connect --apply` writes the portable
  `npx -y moneyswitch mcp` command into Claude Code / Codex configs
  instead of an absolute local path.

## 0.2.0 — 2026-09-25

OpenAI/NewAPI-compatible gateway (`SPEC-v0.2.md`).

- New **Channel** concept (`channels` table + admin CRUD): an upstream
  that speaks the OpenAI protocol and is charged via x402.
- OpenAI-compatible gateway routes, MoneyKey-authenticated: `GET
  /v1/models`, `POST /v1/chat/completions` (non-streaming upstream calls,
  SSE emulation when the client requests `stream:true`), legacy billing
  endpoints `GET /v1/dashboard/billing/subscription` and
  `GET /v1/dashboard/billing/usage`.
- `/v1/chat/completions` responses carry a `moneyswitch` object (`cost`,
  `currency`, `tx_hash`, `network`, `remaining_today`) plus
  `X-MoneySwitch-Cost` / `X-MoneySwitch-Tx` response headers.
- MoneyKeys gained an optional `allowed_models` allowlist.
- `payments` gained `kind` (`fetch`/`chat`), `model`, `prompt_tokens`,
  `completion_tokens` columns, surfaced in `/v1/history` and
  `/v1/admin/usage`.
- demo-seller gained `GET /v1/models` and a x402-priced (0.01 USDC)
  `POST /v1/chat/completions`, with a deterministic offline echo mode for
  tests and an optional real-upstream mode via `DEMO_LLM_UPSTREAM_KEY`.
- Dashboard: Channels page, Playground page (per-message cost + tx link),
  OpenAI/NewAPI client tab on MoneyKey creation, Cherry Studio / Open WebUI
  / NewAPI cards on Connect Agent.

## 0.1.0 — 2026-09-25

Initial implementation (`SPEC.md`), M1–M5.

- MoneyKey (`mk_live_…`) issuance, hashing, and auth; admin token
  (`ms_admin_…`) issuance separate from MoneyKey auth.
- Policy engine (`packages/core`): per-request limit, `max_price`, daily/
  total budget (reserve → settle/release model, one SQLite transaction per
  decision), approval threshold with a pending/approve/deny workflow,
  `max_payments_per_minute` rate limiting, host allowlist enforced on every
  outbound request (including free ones), SSRF guard against MoneySwitch's
  own listening address.
- `LocalWalletDriver` (`packages/wallet`): ethers v6 encrypted keystore,
  never returns/logs the private key or the keystore password.
- x402 client integration (`packages/x402`) against the Monad testnet
  (`eip155:10143`), scheme `exact` (EIP-3009 `transferWithAuthorization`).
- `POST /v1/fetch`: the core paid-outbound-request endpoint, with
  `reserved`/`settled`/`failed`/`unknown` payment status tracking.
- `apps/mcp`: stdio MCP server (`money_status`, `paid_fetch`,
  `money_history`), a pure HTTP client with no wallet/x402 dependency.
- `apps/demo-seller`: an `@x402/express` resource server with four demo
  routes at different price points (free / normal / approval-triggering /
  over-limit).
- `packages/mock-facilitator`: offline facilitator for T2 tests, with real
  EIP-3009 signature verification via viem.
- Three-layer test suite: T1 offline unit/integration, T2 offline
  end-to-end (mock-facilitator), T3 read-only checks against a live Monad
  testnet RPC.
- Dashboard (M5): Overview, MoneyKeys, Usage, Approvals, Wallet pages.
- Secret redaction across logs and audit trail; documented threat model
  (`docs/security.md`).
