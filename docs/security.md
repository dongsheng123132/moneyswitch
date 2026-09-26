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
  explicitly lists that exact `host:port` (this is how the demo-seller,
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
  never written to disk unencrypted, never logged, and never returned by
  any API response.
- The keystore encryption password (`MONEYSWITCH_WALLET_PASSWORD[_FILE]`
  or the `POST /v1/admin/wallet/unlock` body) is never logged.
- Fastify's request logger redacts the `Authorization` header and known
  password fields (see `apps/server/src/app.ts`); `packages/core`'s
  `redact()` helper additionally truncates any string that looks like a
  full `mk_live_`/`ms_admin_` secret before it reaches the audit log.

## Do NOT

- Do not run MoneySwitch's wallet with more USDC than you are prepared to
  lose to a v0.1 bug. Fund the low-balance wallet minimally, top up as
  needed.
- Do not expose the admin API (`Authorization: Bearer ms_admin_xxx` routes)
  to any network the Agent or the public internet can reach.
- Do not import an existing/high-value private key into MoneySwitch — v0.1
  only ever generates a brand-new random wallet (`POST
  /v1/admin/wallet/create`); there is intentionally no "import private key"
  endpoint.
