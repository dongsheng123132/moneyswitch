# Security notes (v0.1)

## Threat model / known limitations

- **Same-OS-user co-location risk.** If the Agent process and MoneySwitch
  run under the same OS user, the Agent already has shell access and can
  read the SQLite database or the encrypted keystore file directly, or ptrace
  the MoneySwitch process. v0.1's isolation guarantee ("Agent never gets the
  private key") only holds if MoneySwitch runs in a **separate OS user,
  a separate container, or a separate machine** from the Agent. This is a
  deployment recommendation, not something v0.1's code enforces.
- **Per-request limit does not stop many small payments.** An agent that is
  allowed to call `/v1/fetch` repeatedly can still drain the daily/total
  budget one small payment at a time. The real defenses are
  `allowed_hosts` (an explicit, small allowlist of hosts the agent can ever
  reach), the daily budget, and `max_payments_per_minute` — not the
  per-request cap alone.
- **`unknown` payment status is counted as spent, conservatively.** If the
  upstream request's outcome can't be determined (timeout, dropped
  connection, unparseable settlement header) after a payment payload may
  have been sent, MoneySwitch keeps the reservation and marks it `unknown`
  rather than `failed`. This can overcount usage; it deliberately never
  undercounts (which would risk quietly exceeding a budget). Audit
  `unknown` payments manually via `GET /v1/admin/usage`.
- **SSRF guard is best-effort hostname/IP-literal matching**, not a DNS
  rebinding defense. It blocks obvious loopback/private-network address
  literals and MoneySwitch's own listening address in any of the common
  literal forms (`127.0.0.1`, `localhost`, `0.0.0.0`, `::1`), and only
  allows a private/loopback target when the MoneyKey's `allowed_hosts`
  explicitly lists that exact `host:port` (this is how the test seller,
  itself running on localhost, is permitted). It does not resolve DNS names
  and re-check the resolved IP before every request.
- **v0.1 has no rate limiting on admin token guesses** beyond what Fastify /
  your reverse proxy provides. Put MoneySwitch behind a firewall; do not
  expose port 4020 to the public internet.

- **Child keys (v0.4) cannot widen authority.** Every limit of a child is
  bounded by its parent at creation, and — independently — every payment
  re-checks the whole ancestor chain (state + per-request + subtree
  daily/total) inside the single `BEGIN IMMEDIATE` reservation transaction,
  so a child can never spend past any ancestor, even with a stale or forged
  in-memory key row. Revoking a key disables its whole subtree immediately
  (evaluated at query time). A parent's `max_payments_per_minute` caps its
  whole subtree, so splitting a key into children does not multiply its
  rate. Child keys are still bearer secrets: whoever holds a delegable key
  can mint up to 100 children per key, and those children can be used by
  anyone they are handed to — revoke the parent to cut all of them off.

## Secrets handling

- The full plaintext MoneyKey and the full admin token are each shown to
  the operator **exactly once** (at creation / first boot) and are never
  logged, never stored in plaintext (only a SHA-256 hash is persisted), and
  never echoed back by any other API response.
- The wallet private key only ever exists decrypted in-process memory
  (inside `LocalWalletDriver`), for as long as the wallet is unlocked. It is
  never written to disk unencrypted and never logged. The only response that
  carries it (or a generated wallet's recovery phrase) is the administrator's
  explicit, address-confirmed `POST /v1/admin/wallet/reveal` (and the one-time
  create/replace response for a new phrase): `Cache-Control: no-store`, and the
  audit log records that it happened, never what.
- The keystore encryption password (`MONEYSWITCH_WALLET_PASSWORD[_FILE]`
  or the `POST /v1/admin/wallet/unlock` body) is never logged.
- Push-notification webhook URLs, tokens and the Feishu signing secret
  (`docs/notifications.md`) are secrets: the admin API only returns them
  masked, they are never logged or written to the audit log, and error text
  returned by `POST /v1/admin/notify/test` is scrubbed of them. They are
  stored as plain text in the server's SQLite file; use the
  `MONEYSWITCH_NOTIFY_*` environment variables to keep them out of it.
- Fastify's request logger redacts the `Authorization` header and known
  password fields (see `apps/server/src/app.ts`); `packages/core`'s
  `redact()` helper additionally truncates any string that looks like a
  full `mk_live_`/`ms_admin_` secret before it reaches the audit log.

## The wallet and its unlock secret

The full model is in [wallet-setup.md](wallet-setup.md). What matters for security:

- **Auto-unlock (the default) trades secrecy for availability.** `wallet.json` is
  encrypted with a random 256-bit secret kept next to it in the data folder
  (`wallet-unlock-<address>.secret`) so the server can restart without a human.
  Whoever can read that folder, including a backup or snapshot of it, can spend the
  wallet. Password mode stores nothing, and the wallet stays locked after a restart
  until someone types the password.
- **The folder is locked down to the server's own account, and that is verified.**
  A file mode alone proves nothing on Windows (a file just inherits the folder's
  ACL, which normally lets other local accounts read it), so on Windows the data
  folder and the secret get a *protected* ACL (inheritance removed) with exactly
  two allow entries, the current user's SID and SYSTEM, set with PowerShell using
  SIDs (never localized account names) and read back. On Linux/macOS the folder is
  `0700` and the secret `0600`. Both are re-applied and re-checked at every start.
  It does not protect against the same OS user (see the threat model above).
- **If it cannot be applied or verified, the server still runs, loudly.**
  `health.secret_protected` is `false` (with the reason), the Wallet page shows a red
  row and the Overview a red banner, and a warning is logged at startup. Keep only a
  tiny float in such a wallet.
- **The mode is recorded, not guessed.** `wallet.json` carries a non-secret
  `x-moneyswitch` marker saying whether it is protected by the auto secret or a
  password. Health, the unlock order and `/backup` follow the marker, never which
  files happen to be lying around. A secret is named after its wallet, so one key's
  secret can never be mistaken for, or overwrite, another's.
- **Nothing that could open a key is ever deleted by accident or left behind by
  accident.** Replacing a wallet copies its files into `retired/` first (verified
  byte for byte), then renames the new files over the live names, so `wallet.json`
  is never absent; a crash at any step leaves a pair that opens. A secret that
  belongs to no live wallet is moved to `retired/`, never unlinked. Turning
  auto-unlock off leaves **no** copy of the old keystore (no `.bak`). One exception to
  "never deleted", on purpose: an unlock secret in `retired/` that still opens a retired copy
  of the key that is live right now (the key was replaced out and back in) is removed once the
  password has proved the live keystore reachable, so that afterwards nothing on disk opens the
  key without the new password. It is the only place a credential is deleted, only inside
  `retired/`, and every removal is written to the audit log
  (`wallet.retired_secrets_removed`). Whatever could not be removed, or was found while the
  wallet is locked (a retired pair may be the only way in, so a locked wallet is never cleaned
  up), is listed in `health.retired_secrets_open_live_key` and shown as a red row.
  `retired/` holds the credentials of old wallets and is as sensitive as the live ones.
- **Imports keep only the key.** Importing a recovery phrase, a private key or a
  keystore stores the private key of that one account, never the phrase, a seed
  or a non-default derivation path. Even so, never import anything that also controls
  other funds: the key sits on this server's disk. Use the optional
  `expected_address` to refuse a key that is not the one you meant.
- **A payment in flight pins the wallet, but cannot starve a replace.** A request takes a
  lease on the signer only when a payment is about to be created (a free resource or an
  unpaid 402 holds nothing) and releases it when the call ends. Locking the wallet is refused
  at once while a lease is open. A replace waits up to 60 s for the open leases while
  **refusing new ones** (`WALLET_BUSY`, `charged: "no"`, nothing reserved or signed), so
  steady traffic cannot keep it waiting for ever; if payments are still in flight after
  that it answers `409 WALLET_BUSY` and changes nothing. A signer whose wallet was replaced
  or locked after the request started refuses to sign (nothing is signed, nothing is
  charged).
- **A crash cannot strand budget.** Payments left `reserved` by a process that died
  are resolved before the next start serves anything: `unknown` if an authorization
  had been signed (the chain decides), `failed` if not (the budget is released).
- **Only EIP-3009 payments are signed.** That sweep reads "no `auth_*` recorded" as "never
  signed". `@x402/evm` signs a Permit2 authorization, which carries no `authorization`
  (from / nonce / validBefore), for a requirement with `extra.assetTransferMethod:
  "permit2"`, so such a requirement (and any method other than absent or `"eip3009"`) is
  refused before anything is reserved or signed: `UNSUPPORTED_PAYMENT`, `charged: "no"`.
- **Back up `/data` as its owner and check the archive.** The folder is `0700`, owned by the
  server's `node` account, and the container drops all capabilities, so root cannot read it:
  a `tar` run as root writes an archive without `wallet.json` and the unlock secret. Use
  `--user node` (see `deploy/README.zh-CN.md`) and `sh deploy/check-backup.sh <archive>`,
  which lists the archive and fails unless the wallet (and, for auto-unlock, the secret of
  the same address) is inside. A backup of `/data` is as sensitive as the key itself.

## Do NOT

- Do not run MoneySwitch's wallet with more USDC than you are prepared to
  lose to a v0.1 bug. Fund the low-balance wallet minimally, top up as
  needed.
- Do not expose the admin API (`Authorization: Bearer ms_admin_xxx` routes)
  to any network the Agent or the public internet can reach.
- Do not give a seller your MoneyKey, and never put a MoneyKey, admin token
  or private key into a receiving-address (pay-to) field. To get paid you
  only ever share your public `0x…` receiving address.
- Do not import a recovery phrase or private key that also controls other
  funds, or a high-value one. MoneySwitch keeps the key on its own disk; the
  wallet it uses must be a dedicated small-float wallet made for AI payments
  (`POST /v1/admin/wallet/create` generates one for you). Importing is meant for
  restoring that same dedicated wallet on a new server.
