# Changelog

All notable changes to MoneySwitch are documented here. Dates are the day
each spec increment was implemented, per the repository's own `SPEC*.md`
files.

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
