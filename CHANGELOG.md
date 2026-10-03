# Changelog

All notable changes to MoneySwitch are documented here. Dates are the day
each spec increment was implemented, per `SPEC.md` (earlier specs: `docs/archive/`).

## Unreleased — v0.7: the small product (2026-10-04)

`SPEC.md` is the only specification now (v0.1 to v0.6 are in `docs/archive/`): an AI spends from a capped key, anything over the approval
line waits for a human, the private key is never given to the AI; a new user makes the first testnet payment within ten minutes. The
database is still **additive only**: no migration was added or removed, no table or column was dropped.

- **Dashboard: four pages and a login.** Wallet, Keys, Approvals and Bills (the old Usage page; `/usage` is now `/bills`, without a
  redirect). Removed: the employee portal (layout, four pages, MoneyKey login), the Playground / test-payment page, the Overview page, the
  setup wizard, the local-launcher entry page, and the wallet import / password / reveal / download / auto-unlock-switch forms with
  everything that only they used. Pages 13 to 5; `apps/dashboard/src` from 13,935 to 6,504 lines (ts + tsx + css). The agent API (`/v1/fetch`,
  `/v1/status`, `/v1/history`, `GET /v1/approvals/:id`) and the child-key back end and routes are unchanged (no UI for child keys).
- **Approval link (SPEC §3).** The `approval_required` envelope of `POST /v1/fetch` now carries `approve_url`
  (`{MONEYSWITCH_PUBLIC_URL}/approvals?id=…`, else the address the server itself listens on, never the request's Host). The link has no token; approving needs the administrator
  login (a visit without a session goes to `/login` and comes back to the same approval). The Approvals page marks and scrolls to the
  linked request. The skill (`/skill.md`, every per-key skill, `skills/moneyswitch-pay/SKILL.md`) tells the AI to give the link to a
  person, poll `GET /v1/approvals/:id` every 15 seconds and resend with the `approval_id`.
- **The ten-minute path (SPEC §0).** On an instance that enables testnets only (a mainnet enabled next to a testnet turns it off: the host
  is not tied to a chain and an issued key cannot be edited) the key form offers "allow the test payment
  endpoint" (ticked by default; adds `app.moneyswitch.dev:443` to the allowed hosts), and the install prompt then asks the AI to call
  `GET /v1/status` and make one test payment to `https://app.moneyswitch.dev/x402-testnet/check` and report the transaction hash.
  Never offered when any mainnet is enabled, and only when the key may pay that host and Monad testnet is enabled (the only chain the
  receiver accepts).
- **Wallet surface (SPEC §1, §5).** Routes: `GET /v1/admin/wallet` (status, balance per chain, replaced wallets), `POST …/create`
  (no password, no import: it refuses both), `POST …/backup/confirm` (now a plain acknowledgement that names the wallet whose words were written down, `409 WALLET_CHANGED` if that is not the current one; the two-word quiz is gone) and
  `POST …/replace`. Removed: `import`, `backup` (download), `unlock`, `reveal`, `auto-unlock`, `GET …/retired`. A wallet made by an
  older version with a password is unlocked only at startup by `MONEYSWITCH_WALLET_PASSWORD` or `_FILE`; a lost password means replacing
  the wallet. Every safety internal stays and keeps its tests: the address-named unlock file, ACL / 0700 / 0600 and the check that it
  worked, temp -> verify -> rename writes, the startup sweep and orphan handling, `retired/` that is never deleted (apart from the one
  audited cleanup for password wallets), waiting up to 60 s for payments in flight, the old signer refusing to sign after a replace.
  Recovering a replaced auto-unlock wallet in MetaMask with the retired keystore and the content of its `.secret` file as password is
  documented in `docs/wallet-setup.md` and checked against an independent Web3 Secret Storage v3 reader
  (`packages/wallet/test/v3-compat.test.ts`); MetaMask itself was not run.
- **Removed: push notifications** (Feishu, WeCom, Telegram, webhook): the notify module, `/v1/admin/notify*`, the outbox, the Dashboard
  settings card, `docs/notifications.md`. Migrations 0005 and 0006 and their tables stay; `migrations-legacy.test.ts` upgrades a 0005 / 0006
  database in place and checks that the bundled migrations are byte-identical to the source ones.
- **Removed: the Windows launchers** (`scripts/start-local.ps1`, `install-local-shortcut.ps1`, `local-server.mjs`,
  `docs/local-desktop.md`) and the routes only they used (`POST /v1/admin/local-link`, `POST /v1/local/claim`).
- **No funding block for a wallet that cannot safely be funded.** The Wallet page shows the address, QR code, balances and faucet steps only
  when the wallet is unlocked and its words are confirmed (`health.backup` is not `missing`); a locked wallet, including an older password
  wallet, and a wallet whose words are still on screen show none of it. The replace form names the current wallet, read-only, marked "do not
  send money to it".
- **The 12 words cannot be lost to a late poll.** The Dashboard polled the wallet every 3 seconds without caring in which order the answers
  came back, and cleared a phrase whose address differed from the wallet on screen: a poll made before "Replace wallet" and answering after
  the new words were shown wiped them, and nothing can show them again. Now `usePolling` applies answers in the order the requests were made
  (a late older answer is dropped), and the phrase is cleared in exactly two places, the acknowledgement and signing out; for another wallet it is
  only hidden. The replace flow puts the new words away before it reloads the page.
- **Links never come from the request.** `approve_url`, the base of `/skill.md`, `public_base` in `/v1/admin/meta` and the first-run sign-in link
  are `MONEYSWITCH_PUBLIC_URL`, else the address the server listens on (`http://127.0.0.1:4020` by default), through one function
  (`apps/server/src/public-base.ts`). Before, the first three used the request's `Host`, so a forged `Host: phish.example` produced
  `http://phish.example/approvals?id=…`, a link the skill tells the AI to forward to the administrator. Without `MONEYSWITCH_PUBLIC_URL` a
  server behind a proxy now names its own listen address: set it (the Docker compose file does).
- **Admin-token reset on Docker and npm (SPEC §2).** `moneyswitch-server reset-admin-token [--data-dir <dir>]` replaces a lost administrator
  token: run on the server itself, as the user that runs the service (the Docker image: `docker compose exec server node /app/dist/cli.js
  reset-admin-token`). It uses the data directory the server uses, the old token stops working at once and the running server needs no restart,
  the new token goes to stdout once and nowhere else (not the server log, not the database: only its hash), and it exits non-zero, changing
  nothing, when there is no database (it never creates one), when the file belongs to another OS user (POSIX) or cannot be updated. It is not an
  HTTP route, so the route inventory is unchanged. `scripts/admin-reset-token.mjs` calls the same `resetAdminTokenInFile` (packages/core); the
  token swap is now one transaction, `openDb` takes `migrate: false` (the reset never runs migrations) and closes its handle when opening
  fails. The Login page shows the command for npm, Docker and a source checkout. `--version` and `--help` no longer start with the
  outbound-proxy line; it is printed only when serving.
- **First start.** The one-time link is `/login#ms_setup_…` (it was `/setup#…`): it signs the administrator in and lands on the Wallet
  page.
- **Dead seller leftovers** removed: the `facilitatorUrl` config field, the `/t/` exclusion in the static-file fallback, stale toll-booth
  comments, `earnings.css`. The seller tables stay in the database, marked LEGACY.
- **Route inventory test (SPEC §9).** `apps/server/test/unit/route-inventory.test.ts` records every route Fastify registers and compares
  it with an explicit list: 26 routes (37 before this round), plus the Dashboard's file wildcard when a Dashboard is built. Administrator
  routes must refuse no credentials and a MoneyKey, MoneyKey routes no credentials and the administrator token; the routes removed in
  this round answer a JSON 404.
- **`scripts/deploy-smoke.mjs`** follows the new surface (26 checks, with the reset command): wallet created without a password, unlocked by itself after a
  restart, unlock file named after the address and protected, an approval link opens the Dashboard, the removed routes are absent.
- **Docs** cut back to this product and pointed at `SPEC.md`: both READMEs, `deploy/README.zh-CN.md`, `docs/wallet-setup.md`,
  `docs/security.md`, `docs/quickstart.md`, `CONTRIBUTING.md`, the pull-request template.

## Unreleased — atomic features only (2026-10-03)

MoneySwitch keeps the wallet, MoneyKeys (with child keys), approvals + push notifications, the ledger / usage, the test-payment page,
the employee self-service portal, the agent skill (per key and `/skill.md`), the Windows desktop launchers, the testnet 0.01 receiver
and `apps/demo-seller` as a test seller. Everything else is removed. Rationale and list: `SPEC-v0.6.md` §2. The database is
**additive only**: no DROP and no deleting migration; old tables and columns stay and are simply no longer read or written.

- **Removed: the OpenAI-compatible gateway and the model channels.** `POST /v1/chat/completions`, `GET /v1/models`, the
  `/v1/dashboard/billing/*` stubs, the admin channel routes (CRUD and probe-models), the Channels page, the chat mode of the Playground,
  the wizard's channel step, the key `allowed_models` field (API and UI; the column is ignored), the model / token columns of Usage
  and History, and the OpenAI error mapping. The `channels` table, `money_keys.allowed_models` and `payments.model / prompt_tokens /
  completion_tokens` stay in the database; old `kind = "chat"` payments still list as ordinary payments. `apps/demo-seller` keeps only
  the minimal x402 test seller (`/free`, `/premium-report`, `/deep-report`, `/greedy`, a priced `POST /echo`, test-only
  `/always-rejected`).
- **Removed: the "Connect an agent" pages** (admin and employee) and every hand-off format but two: the skill (primary) and one raw
  HTTP example for `POST /v1/fetch`. MCP, Codex TOML, OpenAI base-URL, new-api and "message for a colleague" snippets are gone. The skill
  is still one click away everywhere it was: create key, reset secret (drawer and row button), the setup wizard's last step, a newly
  created sub-key and, new, a card on the employee's budget page for the holder's own key.
- **Removed: the offline demo** (`moneyswitch demo`, `moneyswitch-server demo`, `src/demo.ts`, the demo banner / guide card / simulated
  balance / `demo` flags of `/v1/setup/status` and `/v1/admin/meta`, `pnpm demo:local`). `packages/mock-facilitator` stays as a test
  fixture; `pnpm demo:testnet` (test seller + server on the real testnet facilitator) stays.
- **Removed: MCP and the `moneyswitch` CLI package** (`apps/mcp`, `apps/cli`, which contained nothing but `demo` and `mcp`), the
  `GET /dl/moneyswitch.tgz` download and the CLI / MCP path fields of `/v1/admin/meta`; dropped from the workspace, the build / test
  chains and the lockfile (the MCP SDK and the root `openai` dev dependency go with them).
- **Setup wizard and navigation.** The wizard is admin -> wallet -> first key (it now asks for the allowed hosts the channels used to
  supply) -> give the skill to your AI. Admin nav: Overview, Test payment, Keys, Usage, Approvals, Wallet. Employee nav: Budget, Test
  payment, History, Sub-keys.
- **Copy.** The Receive card no longer mentions a toll booth, the dead `PayToField` and the seller / channel / demo strings are gone,
  READMEs, the website and the docs that only covered removed features (`docs/claude.md`, `docs/codex.md`, `docs/desktop-agents.md`,
  `docs/demo*.md`) were cut back to the product that is left. `retiredHint` no longer promises "import its recovery phrase": the funds
  of a retired wallet are recoverable only with something the owner kept (phrase or private key, or the file plus its password).
- **Shell scripts are pinned to LF** (`.gitattributes`: `*.sh text eol=lf`; `deploy/*.sh` normalised): a Windows checkout turned
  `upgrade-us.sh` into a CRLF file that `sh` cannot run.
- **Tests.** `buyer-only.test.ts` pins the 404s (gateway, models, billing stubs, channels, demo routes, CLI download) and that old chat
  rows still list; the `moneyswitch-server` end-to-end test now boots the built bundle on a throw-away data dir (setup link, key, skill,
  removed routes, `demo` refused).

## Unreleased — a wallet you cannot lose by forgetting a password

Incident: two funded wallets became unreachable in one week (a local mainnet
wallet holding 0.52 USDC, and the US server's testnet wallet whose auto-unlock
file was empty). The server needed the wallet password on every restart, creating
a wallet never made anyone save it, there was no backup that works without that
same password, nothing showed that a restart would lock the wallet, and a lost
password left only a brand-new instance (losing every key, budget and history
row). The server wallet is a small float hot wallet: a person should not have to
remember a password for it, and recovery now comes from a standard recovery
phrase. Full model: [`docs/wallet-setup.md`](docs/wallet-setup.md) and
`SPEC-v0.6.md` §6.

- **Auto-unlock is the default.** Creating or importing a wallet without a
  password encrypts the keystore with a random 256-bit secret stored in
  `<data dir>/wallet-unlock-<address>.secret` (named after its wallet, written
  atomically, never returned by an API, never logged). Startup unlock order:
  `MONEYSWITCH_WALLET_PASSWORD` / `_FILE` if non-empty (an empty variable, an
  empty or blank file or an unreadable file is "not configured" and logged: the
  placeholder file older Docker deployments mount is harmless), else
  the wallet's own unlock secret, else locked. A source that exists but fails is logged
  without any credential (each source with its own reason), shown in the new health
  block and as an Overview banner, and the next source is still tried. Passing a `password` to create /
  import keeps the old password mode (no secret file).
  **Honest trade-off:** whoever can read the data folder (backups and disk
  snapshots included) can spend the wallet. Keep the float small, run team
  servers on a separate machine, treat `/data` backups as private keys. An
  existing wallet keeps its mode: nothing is migrated to auto-unlock by itself.
- **Recovery phrase.** New wallets are made from a BIP-39 12-word phrase on
  `m/44'/60'/0'/0/0`, so MetaMask / OKX show the same address (tested against an
  independent BIP-32/44 derivation and published vectors). The phrase is returned
  once by `POST /v1/admin/wallet/create` (admin only, `Cache-Control: no-store`)
  and lives only inside the encrypted keystore. `POST
  /v1/admin/wallet/backup/confirm` checks two words at 1-based positions and
  records `backup_confirmed_at`; `POST /v1/admin/wallet/reveal` returns the
  phrase (or the private key of a wallet imported from a key) only when
  `confirm_address` echoes the current address exactly, with an audit row that
  never contains the secret. `POST /v1/admin/wallet/import` accepts a new
  `kind: "mnemonic"` (12 or 24 words, account 0). The Dashboard hides the
  deposit address, QR code and funding steps (and the address chip in the top bar)
  until the backup is confirmed.
- **Turn auto-unlock on / off** (`POST /v1/admin/wallet/auto-unlock`). On needs
  an unlocked wallet and re-encrypts it with a fresh secret; off needs a new
  password (8+ characters) and removes the secret file. Crash-safe: the new
  keystore is built and test-decrypted before anything on disk changes, the old
  one is NOT kept (no `wallet.json.bak-*`: a retired credential must not keep
  opening the key), the new keystore is renamed over `wallet.json`, the secret is
  installed before the swap (or removed after it), and a failure part-way renames
  the previous files back over.
- **Replace wallet** (`POST /v1/admin/wallet/replace`, for a lost password or a
  suspected leak). Needs `confirm_address`; refused with `409 WALLET_BUSY` while
  any request holds the wallet's signer. The old `wallet.json` (and secret) are
  copied, verified, kept (never deleted) in
  `<data dir>/retired/wallet-<address>-<timestamp>.json`, and the new files are
  renamed over the live names, so `wallet.json` is never absent; the
  retirement is recorded in the new `wallet_retirements` table and in the audit
  log. MoneyKeys, budgets, approvals, payment history and notification settings
  are untouched, and reconciliation of old `unknown` payments keeps working (it
  reads each payment's stored `auth_from`). `GET /v1/admin/wallet/retired` lists
  retired wallets with their live USDC balance.
- **Health.** `GET /v1/admin/wallet` keeps every existing field (`auto_unlock_configured`
  now also covers the secret file) and adds `health`: `unlock_mode` (`auto` /
  `env_or_file` / `manual` / `none`), `auto_unlock_ok` (result of the last real
  decrypt), `backup` (`confirmed` / `missing` / `not_applicable`), `float_limit`
  (`MONEYSWITCH_WALLET_FLOAT_LIMIT`, default 50 USDC), `over_float_limit` per
  enabled chain whose balance is known, and `retired_wallets`. Balance reads are
  shared between polls for a few seconds. `POST /v1/admin/wallet/backup` with a
  `password` returns a portable keystore protected by it; an auto-unlock wallet's
  own `wallet.json` is no longer offered (its secret is never exported).
- **Dashboard** (zh + en). The setup step defaults to "Create wallet
  (recommended)" with no password field: one click, the 12 words, two random words
  to confirm; importing a phrase / private key / keystore and an "ask for a password
  on every restart" toggle are secondary. The Wallet page gets a health card
  (auto-unlock, backup, balance against the float limit) and a danger zone
  (reveal, auto-unlock on / off / repair, encrypted backup, replace wallet with the
  address typed in, retired wallets with live balances). The Overview warns when the
  backup is missing or auto-unlock is broken.
- **Removed: the Monad mainnet 0.1 USDC receiver** (out of scope; its server
  deployment was already removed): its mode in `apps/demo-seller/receiver.mjs`, its
  tests, the `/x402-receive/*` Caddy handle and the mainnet parts of the receiver
  deploy files and docs. The testnet 0.01 test-USDC endpoint
  (`/x402-testnet/check`), which employees use to verify their setup, stays;
  `RECEIVER_MODE=mainnet` is refused.
- **Schema:** additive migration `0007_wallet_lifecycle` (`wallet_meta.backup_confirmed_at`
  and `origin`, new table `wallet_retirements`). An old image can still open the
  upgraded database, and `deploy/upgrade-us.sh` relies on that when it rolls back:
  the migration runner records applied files by name and ignores names it does not
  know, and the old image never reads or writes the new columns or table (tested in
  `packages/core/test/wallet.test.ts`). It cannot open a wallet that was switched to
  auto-unlock afterwards, so the upgrade itself never converts one.
- **Security review fixes** (all reproduced as failing tests first):
  - *The unlock secret belongs to its wallet* and nothing is ever unlinked for another key:
    `wallet-unlock-<address>.secret`; a same-named file and every orphan is moved to
    `retired/`; replace copies first and renames the new files over the live names;
    crash-point sweeps over every file-system call of create, replace and both toggles
    always leave a `wallet.json` something can open; renames and deletes are retried on
    Windows (EPERM/EBUSY/EACCES). Health reports "wallet.json missing but credential
    files present" and the Dashboard asks for an explicit yes instead of silently
    offering Create.
  - *Imports keep only the account-0 private key* (never the phrase, a seed or a
    non-default path); `reveal` returns the key; only generated wallets have a phrase.
    Every import screen warns: never import anything that also controls other funds, the
    wallet must be a dedicated small float. Optional `expected_address` refuses a key that
    belongs to another address.
  - *The data folder and the secret are protected for real*: a protected DACL with only the
    current user's SID and SYSTEM on Windows (verified against real `icacls`), 0700/0600 on
    POSIX; if it cannot be applied or verified the server still runs, with
    `health.secret_protected=false`, a red row and an Overview banner.
  - *Payments cannot be stranded or signed by the wrong wallet.* Before serving, payments a
    dead process left `reserved` become `unknown` (signed, the chain decides) or `failed`
    (nothing signed, budget released). Requests lease the signer; replace and lock refuse
    with `WALLET_BUSY` while one is open (no more database rows), and a signer whose wallet
    changed refuses to sign (`WALLET_LOCKED`, charged `no`, reservation released).
  - *The mode is recorded in `wallet.json`* (non-secret marker) and health, banner and
    `/backup` follow it: an auto keystore with a missing secret is "auto, secret_missing",
    a stale env password is not blamed for a wrong secret, a manual wallet created next to a
    leftover secret is manual. A locked auto wallet no longer gets a password form.
  - `unlock()` runs inside the same per-directory lock as replace and verifies the address it
    adopts; the toggles refuse when `wallet.json` is no longer the unlocked wallet.
  - The header chip shows no address while the backup is unconfirmed; the in-memory fresh
    phrase is stored with its address and shown only for that wallet.
  - `apps/demo-seller`'s `receiver.test.mjs` now runs in `pnpm test`.
  - *A locked wallet whose password is lost can always be replaced.* Replace only moves files, so it
    works on a locked wallet (end-to-end test: a keystore written by the previous release, server started
    with no credential, replace, new wallet open, old file in `retired/`, keys and history intact). The
    Replace dialog now always names the current wallet, read-only, as the one that will be retired
    ("do not send money to it"), so it can be typed even though the deposit address stays hidden
    everywhere else while the backup is unconfirmed (header chip, receive card). The dialog is reachable
    from the Wallet page and from the setup guide; the backup screen of a locked wallet offers "unlock
    with the password" or "replace the wallet" instead of a "Show my recovery phrase" that cannot work.
  - `LocalWalletDriver.getSigner()` is gone: `leaseSigner()` is the only way to get a signer, so a future
    route cannot sign without being counted by replace and lock.
- **Third review round** (eight more findings, found by fault injection; each reproduced as a failing test first):
  - *"Nothing opens the key without the new password" is true after turning auto-unlock off.* A secret left in
    `retired/` by an earlier replace of the same key (A to B to A) still opened a retired copy of it. Whenever a
    password-mode key has just been proved reachable by its password (auto-unlock off, a manual import or replace,
    *Unlock*, the startup password), every `retired/` secret that opens a retired copy of the live key is removed: the
    only place a credential is deleted, only inside `retired/`, audited as `wallet.retired_secrets_removed` and returned
    as `retired_secrets_removed`. A locked password wallet is never cleaned up (a retired pair may be the only way in);
    what is left is flagged in `health.retired_secrets_open_live_key`, a startup warning and a red row on the Wallet page.
  - *A replace cannot be starved.* A request takes its signer lease when a payment is about to be created (after the
    unpaid probe), not at its start, so free resources and unpaid 402s hold nothing. While a replace waits, new leases are
    refused (new error code `WALLET_BUSY`, `charged: "no"`, nothing reserved or signed; HTTP 503 on the gateway) and it
    waits up to 60 s for the open ones before answering `409 WALLET_BUSY`. Locking is still refused at once.
  - *The Windows ACL check reads SIDs.* Only SYSTEM's SDDL alias was understood, so a server running as Local Service,
    Network Service or the built-in Administrator was told its own correctly protected folder was "not protected". The
    ACL is now read back as SIDs and judged against exactly the current account and SYSTEM.
  - *The ACL tool no longer blocks the event loop.* PowerShell runs through an async `execFile` with the same timeout;
    requests are served while it runs, and a PowerShell that never answers is cut off and reported as not protected.
  - *The documented backup actually contains the wallet.* `docker compose run --user root tar` cannot read the 0700 data
    folder under `cap_drop: ALL` and silently wrote an archive without `wallet.json` and the unlock secret. The command
    now runs as `node`, and the new `deploy/check-backup.sh` lists an archive and fails unless `wallet.json` (and, for
    an auto-unlock wallet, the secret of the same address) is inside.
  - *A replace that fails twice never strands the new secret.* If the database hook throws AND putting `wallet.json`
    back fails, the undo removes the new secret only when the live keystore is the old one again.
  - *Only EIP-3009 payments are signed.* The startup sweep reads "no `auth_*`" as "never signed", but `@x402/evm` signs a
    Permit2 authorization (no `authorization` in the payload) for `extra.assetTransferMethod: "permit2"`. Such a
    requirement, and any method other than absent or `"eip3009"`, is refused with `UNSUPPORTED_PAYMENT` and
    `charged: "no"` before anything is reserved or signed; a seller offering both is paid with EIP-3009. An offer that
    our own policy empties is now reported as `UNSUPPORTED_PAYMENT` (it used to surface as `UPSTREAM_ERROR`).
  - *A secret tidied away while `wallet.json` belonged to another key comes back.* At startup an auto-unlock wallet
    whose secret is missing tries the orphans of its own address in `retired/` and moves the one that opens it back
    (logged); otherwise the log names the exact `retired/` files instead of "restore from a backup".
  - Copy: the locked-wallet hints no longer promise that the old wallet's money "can be recovered with its recovery
    phrase" (a legacy wallet never showed one): only if you separately kept the phrase or private key, or remember the
    password. The Wallet page heading "One wallet - receives and pays" (一个钱包，收付一体) implied a seller side that
    no longer exists and is now "Wallet: funding and payments" (钱包：充值与付款来源).
- Tests: driver unit tests for every path above (including injected I/O failures
  at each step of the toggles and the replacement, and process-death sweeps), route tests,
  a real-`icacls` ACL test, an end-to-end test that kills the server process and starts it
  again on the same data directory with no password, an end-to-end test of a paid fetch in
  flight while a replace is attempted, and Dashboard render tests.

## Unreleased

"Paid but no delivery" fix. Incident: on Monad testnet a slow LLM seller took
more than 30 s, MoneySwitch aborted after it had already signed the payment,
the seller still settled (tx `0x20b9a9edf1...`, block 66811924), and the agent
was told `UPSTREAM_ERROR` — which looks retryable, so a retry would have paid
twice — while reconcile could only say the authorization had been used, without
a tx hash.

- **Two-phase deadline** (`performPaidFetch`). Before a payment authorization
  is signed the unpaid probe has `MONEYSWITCH_PROBE_TIMEOUT_MS` (default
  30000). The moment a payment is signed the deadline is replaced by
  `MONEYSWITCH_PAID_TIMEOUT_MS` (default 300000), which also bounds reading
  the response body. Invalid values (`0`, negative, non-numeric, above the
  timer limit) fall back to the defaults; the timeout can never be disabled.
  The deadline is really ours: the abort signal is passed straight to the
  outbound fetch (it used to travel through `@x402/fetch`'s `Request` clones,
  which undici links with WeakRefs, so after a major GC `abort()` could stop
  reaching the in-flight paid request and its body read), and the outbound
  request uses `callerDeadlineDispatcher()` from `@moneyswitch/net`, which
  keeps the process-wide dispatcher (so an outbound proxy still applies) but
  switches off undici's own 300 s headers/body idle timers — otherwise a
  `MONEYSWITCH_PAID_TIMEOUT_MS` above 300000 would be cut at 300 s with the
  wrong code. `@moneyswitch/x402` now depends on `@moneyswitch/net`.
  If the probe deadline expires before the payment is sent (a 402 body that
  trickles in past it, or slow signing) nothing is reported as possibly paid:
  no reservation is made, or an already-made one is released
  (`ABORTED_BEFORE_SEND`), and the call is an ordinary `UPSTREAM_ERROR` with
  `charged: "no"`.
  Note: the worst case for one `/v1/fetch` call is now probe + paid
  (about 330 s by default); an HTTP client of MoneySwitch needs a read
  timeout above that (the in-repo MCP and qwen-agent clients now have one).
- **Settlement is recorded from the response headers before the body is
  read.** If the body then fails or stalls, the payment row is still
  `settled` with its tx hash, and `/v1/fetch` returns `status: "error"`,
  `code: "UPSTREAM_BODY_INCOMPLETE"`, `charged: "yes"` with `payment`
  populated and a reason that says not to retry.
- **A seller's `PAYMENT-RESPONSE` with `success:false` is no longer "nothing
  was charged".** We signed and sent an authorization that stays valid until
  `validBefore`, and a resource server turns any exception while settling into
  this header (`@x402/evm` even answers `settlement_pending` with the hash of a
  transfer it already broadcast). Previously the row was released as `failed`
  and `/v1/fetch` returned `status: "ok"` with `charged: "no"` — a retry could
  pay twice and the ledger undercounted. Now the row stays `unknown`
  (`SETTLE_NOT_CONFIRMED`, budget held, any reported tx hash kept as a lead),
  the envelope is `payment_failed` / `PAYMENT_REJECTED` with `charged:
  "maybe"`, and reconcile settles or releases it from the chain.
- **New `/v1/fetch` status `payment_unknown`** (codes `TIMEOUT_AFTER_PAYMENT`
  for a deadline abort, `UPSTREAM_ERROR_AFTER_PAYMENT` for any other failure)
  when a payment was signed and the response was lost. `charged: "maybe"`,
  `payment: { amount, network, tx_hash: null }`, a human-readable `reason`
  telling the agent NOT to retry automatically. The payments row is marked
  `unknown` with that error code and its budget stays reserved until reconcile
  resolves it. Before any signature the codes are unchanged
  (`UPSTREAM_ERROR`, ...) with `charged: "no"`.
- **`charged` on every `/v1/fetch` envelope**: `"yes"` (a settlement was
  confirmed), `"no"` (definitely nothing signed or charged), `"maybe"` (a
  payment was signed and its outcome is unknown: `payment_unknown`,
  `PAYMENT_REJECTED`, and a 200 without a settlement header; the 401 from the
  key guard is `"no"`). All existing fields are unchanged. New `PaidFetchResult` fields in `@moneyswitch/x402`:
  `charged`, `paymentUnknown`, `bodyIncomplete`; once a payment is signed
  `performPaidFetch` returns these instead of throwing.
- **Request body encoding** for `/v1/fetch` is now explicit: a JSON
  object/array is sent as JSON with `content-type: application/json` unless
  the caller set a content-type (any casing); a string is sent verbatim
  (previously it was JSON-quoted, i.e. double-encoded). An approval's
  `body_sha256` is computed over exactly those wire bytes, so an approved retry
  still matches. Object and `undefined` bodies hash exactly as before; a
  *string*-body approval created before this release and still pending will not
  match the new hash (10-minute TTL; request again).
- **OpenAI-compatible gateway** (`/v1/chat/completions`): `payment_unknown` /
  `UPSTREAM_BODY_INCOMPLETE` become an OpenAI-style error with HTTP **400**,
  plus `x-should-retry: false`, a message saying the call may have been charged
  and must not be retried blindly, and `moneyswitch_charged` (+ `payment`) in
  the error object. 400 on purpose: the OpenAI SDKs skip it, and so does the
  new-api relay, which ignores `x-should-retry` and (with `RetryTimes > 0`)
  retries every status in its default ranges — 402 included — but not 400/408/
  504/524, so a 402 would have made it sign a second payment for the same
  prompt. `PAYMENT_REJECTED` (charged "maybe") moves from 402 to 400 for the
  same reason and now also sends `x-should-retry: false`; budget denials stay
  402 (nothing was signed). The non-JSON-upstream error carries
  `moneyswitch_charged` too; successful responses carry `moneyswitch.charged`.
- **Reconcile finds the tx hash of an authorization that was used on-chain.**
  The old lookup asked `eth_getLogs` for one huge range, which public RPCs
  reject (Monad testnet: "eth_getLogs is limited to a 100 range"), so rows were
  settled as `SETTLED_TX_UNKNOWN`. It now derives a block window from the
  payment's creation time and the authorization's `validBefore` (interpolating
  on real block timestamps), then scans it chronologically in chunks for
  `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` and
  stores the tx hash. Best effort: bounded by `MONEYSWITCH_RECONCILE_LOG_CHUNK_BLOCKS`
  (default 100) and `MONEYSWITCH_RECONCILE_LOG_MAX_CALLS` (default 60 RPC
  calls per payment); `MONEYSWITCH_RECONCILE_BLOCK_TIME_MS` is only the initial
  block-time guess. A failing lookup never blocks reconcile (the row is
  settled without a hash, as before). `AuthorizationReader.findAuthorizationUsedTx`
  receives the new optional `validBeforeSec`. Opt-in check against the real
  incident (read-only, not in the default run): `pnpm test:incident`.
  - **Backfill for rows that were already settled without a hash**
    (`SETTLED_TX_UNKNOWN`: an earlier build, or a lookup that hit an RPC error
    or the call cap — the incident's own row is one). The server's reconcile
    loop retries them — 3 rows per pass, newest first, only rows from the last
    14 days, at most every 15 minutes and on the first run after boot;
    `POST /v1/admin/reconcile` does it on demand and reports `tx_backfilled`.
  - **Reconcile runs can no longer overlap or undo each other.** A run can now
    take minutes on a slow RPC, longer than the 60 s tick. One run at a time per
    server (a second call joins the one in flight), and the reconcile
    transitions only apply to a row that is still `unknown` and unreconciled, so
    a slower run can no longer overwrite a found tx hash with `null` or write a
    duplicate audit entry. A tx hash the seller reported (`SETTLE_NOT_CONFIRMED`)
    is kept instead of being looked up again.
- **MCP `paid_fetch`** reports `payment_unknown`, `UPSTREAM_BODY_INCOMPLETE`
  and `charged: "maybe"` with a bilingual (zh + en) message that says not to
  retry; `@moneyswitch/mcp` now has unit tests (`pnpm --filter @moneyswitch/mcp test`).
  Its HTTP client no longer uses the global `fetch` (undici gives up on response
  headers after ~300 s, before a slow paid call's verdict can arrive): it uses
  `node:http` with explicit deadlines (`MONEY_API_FETCH_TIMEOUT_MS`, default
  600000 for `/v1/fetch`; `MONEY_API_TIMEOUT_MS`, default 30000 for status and
  history), and a transport failure after the request was sent is reported as
  "outcome unknown, you may have been charged, do NOT retry, check
  `money_history`" (zh + en) instead of a bare "fetch failed". The qwen-agent
  demo client got the same transport and message, and passes `charged` on.
  Note that an MCP host's own tool timeout (often 60 s) can still end the call
  earlier; the server keeps going, so check `money_history` before retrying.
- **Dashboard Playground** (paid-fetch panel and chat) understands
  `payment_unknown`, `charged` and `UPSTREAM_BODY_INCOMPLETE`: it warns that the
  call may have been charged and not to send it again, instead of showing no
  outcome, "Free — nothing was charged" or "didn't go through".
- No database schema change.
## Unreleased — one paste gives an AI agent payment ability

The primary way to connect an agent is now a paste-able text block, not MCP:
a skill (Agent Skills `SKILL.md`) that carries this server's address and
that agent's own MoneyKey, plus a short zh+en install instruction. MCP, the
CLI, the OpenAI-compatible gateway and REST stay as advanced options.

- **New workspace package `@moneyswitch/skill`** (`packages/skill`,
  Apache-2.0, browser-safe, no node-only deps): `renderSkill({ baseUrl, key?,
  keyName? })` (personalized when a key is given; generic otherwise: reads
  `MONEY_API_BASE` / `MONEY_API_KEY` and asks the user to paste their
  dashboard skill when they are missing) and `renderInstallPrompt({ baseUrl,
  key, keyName?, agent })` for `codex | claude-code | openclaw | hermes |
  other`. One renderer feeds the Dashboard, `GET /skill.md` and the repo copy,
  so they cannot drift. The skill covers what a MoneyKey is, the secret rules,
  `POST /v1/fetch` with working bash / PowerShell / Python examples, a
  per-status action table (`ok`, `denied`, `approval_required`,
  `payment_unknown`, `payment_failed`, `error`), the `charged` field,
  `/v1/status`, `/v1/history` and `/v1/approvals/{id}`. The renderers
  refuse keys and base URLs that could break out of the quoted shell strings.
  Skill locations used by the install prompt (each + `moneyswitch-pay/SKILL.md`),
  checked against the installed tools and chosen so that only that agent loads
  the file, because the file holds that agent's own key: Codex
  `~/.codex/skills/` (`$CODEX_HOME/skills`), Claude Code `~/.claude/skills/`,
  OpenClaw `<workspace>/skills/` (default `~/.openclaw/workspace/skills/`; where
  a ClawHub install lands too, so the personalized copy replaces the generic
  one), Hermes `$HERMES_HOME/skills/` (default `~/.hermes`,
  `%LOCALAPPDATA%\hermes` on native Windows, one per profile). Never the shared
  `~/.agents/skills/`: Codex and OpenClaw both read it and OpenClaw ranks it
  above its own `~/.openclaw/skills/`, so one agent would pay with the other's
  key. The prompt also tells the agent to overwrite an existing
  `moneyswitch-pay` skill in place instead of keeping two. Any other agent gets
  a generic "your skills directory" phrase instead of a guessed path. The
  PowerShell example builds objects with `[ordered]@{...}`: PowerShell 7 gives a
  plain `@{...}` another key order in every process, and an approval only
  matches a body with the same key order.
- **`skills/moneyswitch-pay/SKILL.md`**: the generic variant, generated from
  the renderer (`pnpm --filter @moneyswitch/skill gen`) with a test that fails
  when the file drifts. Prepared for a later ClawHub publish; nothing has
  been published.
- **`GET /skill.md`** (public, `text/markdown; charset=utf-8`): the generic
  skill, base URL from `MONEYSWITCH_PUBLIC_URL` when set, else the request
  origin (only if it forms a plain http(s) origin; never contains a key).
- **`GET /v1/approvals/:id`** (MoneyKey): the agent polls its own approval,
  `{ id, status, amount, currency, url, method, expires_at }`; another
  key's id and unknown ids both answer 404.
- **`POST /v1/keys/:id/rotate`** (admin): a new secret for the same key id.
  Only hashes are stored, so a lost secret cannot be shown again; rotating
  keeps budgets, usage history, approvals, child keys and settings, the old
  secret stops working immediately (also for a request that authenticated with
  it just before and is still waiting for the seller: that request is refused
  with `KEY_INVALID` before anything is reserved or signed), an audit row
  `key.rotate` (prefixes only) is written and the new plaintext is returned
  once. Revoked keys answer 409 and stay revoked. No schema change.
- **Dashboard**: after creating a key the first and default tab is "Give this
  to your AI (skill)" with an agent selector and one large copy button for the
  install text (shown masked, copied in full, in the amber secret box); the
  previous connect / MCP / OpenAI / new-api snippets sit under "Other ways
  (advanced)". The key list gets the row action "Reset secret and copy skill"
  with a confirmation dialog. The Connect agent page and the employee view
  lead with the same block (the employee's own key is filled in); so do the
  last step of the first-run setup wizard and the drawer after an employee
  creates a sub-key (with the sub-key, not their own key). Key names are
  nudged to be one per agent. A page opened from an address the skill cannot
  use (for example a host name with an underscore) shows a warning instead of
  failing to render. zh + en. The Dashboard now has tests
  (`pnpm --filter @moneyswitch/dashboard test`, Node's test runner).
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
