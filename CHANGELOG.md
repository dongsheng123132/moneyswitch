# Changelog

All notable changes to MoneySwitch are documented here. Dates are the day
each spec increment was implemented, per the repository's own `SPEC*.md`
files.

## Unreleased — 2026-10-02

- **Approval push notifications.** When a payment needs human approval the
  operator now gets a short zh message right away (key name, amount in USDC,
  destination host + path only, method, minutes left, approval id, link to
  `{MONEYSWITCH_PUBLIC_URL}/approvals`) instead of having to open the Approvals
  page; approvals expire after 10 minutes. Channels, in any combination:
  Feishu custom bot (optional signing secret), WeCom group bot, Telegram bot,
  generic JSON webhook. Details and how to get each webhook:
  [`docs/notifications.md`](docs/notifications.md).
  - Delivered by an outbox loop beside the HTTP server (every 2.5 s,
    `MONEYSWITCH_NOTIFY_INTERVAL_MS`, `0` = off), never on the payment path:
    pending, unexpired approvals are sent once per channel (also across
    restarts and with several processes on one database), never after they
    expired. Every channel is delivered and retried on its own (back-off, at
    most 5 attempts, then a warn log), so a channel that failed still gets
    its retries when another channel already took the approval, and a slow
    or black-holed channel only delays itself.
  - No flood: a repeat of a request that is still pending and already
    announced (same key, URL, method, body, payee, price) is not announced
    again, and one key gets at most 5 approval messages per minute and
    channel, then a single "approval_digest" summary, then silence until the
    minute is over.
  - The offline demo delivers to channels saved in its own Dashboard and
    ignores `MONEYSWITCH_NOTIFY_*` from the environment.
  - Config is editable in the Dashboard (Approvals → Notifications, with a
    "send test message" button) and persisted in SQLite; the env vars
    `MONEYSWITCH_NOTIFY_FEISHU_WEBHOOK`, `_FEISHU_SECRET`, `_WECOM_WEBHOOK`,
    `_TELEGRAM_BOT_TOKEN`, `_TELEGRAM_CHAT_ID`, `_WEBHOOK_URL` override it
    field by field. Webhook URLs and tokens are secrets: returned masked,
    never logged, never in the audit log. The masked form hides the host
    too (`https://••••.feishu.cn/••••6789`), because for some webhook
    services the host is the secret.
  - New admin routes `GET` / `PUT /v1/admin/notify` and
    `POST /v1/admin/notify/test` (per-channel ok/error).
  - Database: additive migrations `0005_approval_notify` (columns
    `approvals.notified_at`, `notify_attempts`, `notify_attempt_at` - the
    last two are superseded by 0006 and no longer written - and table
    `notify_settings`) and `0006_approval_notify_deliveries` (table
    `approval_notify_deliveries`, one row per approval and channel); existing
    databases upgrade in place.

## 0.5.1 — 2026-09-26

Zero-setup trial and one-command self-hosting.

- **New npm package `moneyswitch-server` 0.5.1** (`apps/server-pkg`,
  AGPL-3.0-only): the server, Dashboard and all AGPL/Apache workspace code
  (core, db, x402, wallet, tollbooth, mock-facilitator, demo-seller) bundled
  with esbuild into one file, plus the prebuilt Dashboard and the SQL
  migrations. Only runtime dependency: `better-sqlite3` (native; its npm
  package ships prebuilt binaries for Windows / macOS / Linux, x64 + arm64).
  Node.js 22+ (required by better-sqlite3 13).
  - `npx moneyswitch-server [--data-dir] [--port] [--host]`: self-hosted
    server + Dashboard, data in `~/.moneyswitch/server` by default; first
    start prints the admin token and the one-time setup link as before.
  - `npx moneyswitch-server demo [--port] [--no-open]`: fully offline demo in
    one process — mock facilitator, demo seller (LLM echo mode) and server on
    free ports from 4020 up, a throwaway temp data dir, a mock wallet
    (simulated 20 USDC), channel "Demo LLM (x402)", MoneyKeys "Claude Code" and
    "Codex", toll booth "Demo Weather API" in front of the demo seller, and a
    few real mock-settled payments. Opens the Dashboard signed in through the
    server's own one-time setup link (the MoneyKey for the Playground rides in
    the same URL fragment; no new authentication path). Ctrl+C closes every
    service and deletes the temp dir; dirs left by a hard-killed demo are
    swept on the next run.
- **`moneyswitch demo`** (`moneyswitch` 0.5.1, Apache-2.0): runs
  `npx -y moneyswitch-server@<same version> demo`, passing arguments through;
  `--registry=<url>` goes to npx. If the package is not found and the
  registry is not registry.npmjs.org, it suggests
  `--registry=https://registry.npmjs.org/`. `MONEYSWITCH_SERVER_SPEC`
  overrides the package spec (e.g. a local `.tgz`). The help states that it
  downloads the AGPL-3.0-only server package. `moneyswitch --version` added.
- **Dashboard demo mode**: an always-visible "DEMO · simulated settlement — no
  real money moves" banner on every screen (login and setup included), a
  "Demo · mock settlement" network badge, and an overview guide card: send a
  Playground message ($0.01) / buy the $5 report and watch it get blocked /
  see the toll booth's income.
- Server: `GET /v1/setup/status` and `GET /v1/admin/meta` report `demo`;
  in demo mode `GET /v1/admin/wallet` returns a simulated balance
  (`simulated: true`) instead of querying the chain, and on-chain
  reconciliation is off. `startServer()` (`apps/server/src/start.ts`) is the
  shared boot path; `buildContext` accepts `onFirstRun`; `dashboardDir` /
  `migrationsDir` are configurable (`MONEYSWITCH_DASHBOARD_DIR`, `openDb({
  migrationsDir })`). The demo seller is now a factory
  (`@moneyswitch/demo-seller/app`) and serves a free `GET /weather` upstream
  for the toll booth demo.
- Docs: README / README.zh-CN quick start and the site now use the published
  commands (`npx moneyswitch demo`, `npx moneyswitch-server`,
  `npx moneyswitch connect / ui / sell`); the site gains a "Get paid: toll
  booths" section and marks v0.5 done.

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
