# Security Policy

MoneySwitch moves real money (USDC on a live blockchain testnet, and
eventually mainnet). Please report suspected vulnerabilities privately.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Please use [GitHub Security Advisories](https://github.com/dongsheng123132/moneyswitch/security/advisories/new)
for this repository ("Security" tab → "Report a vulnerability"). This
creates a private conversation with the maintainers before any public
disclosure.

If you can't use GitHub Security Advisories for some reason, open a regular
issue asking a maintainer to contact you privately, without describing the
vulnerability itself.

Please include:

- What component is affected (server, dashboard, MCP, connect/cli, a
  specific package).
- Steps to reproduce, or a minimal proof of concept.
- What you believe the impact is (e.g. "an agent with a scoped MoneyKey can
  exceed its `total_budget`", "SSRF guard can be bypassed to reach an
  internal host").
- Whether real funds are needed to reproduce it (if so, please use a
  testnet wallet with minimal funds, not anything real).

We'll acknowledge reports as promptly as we can and keep you updated as we
investigate and fix the issue.

## Known limitations

These are documented, known-and-accepted-for-now limitations, not
undisclosed vulnerabilities — reading `docs/security.md` before deploying
with real funds is expected. Reporting these specific, already-documented
items is welcome if you have a concrete new attack that exploits them
further, but a report that only restates one of these won't be treated as
a new finding.

- **Same-OS-user co-location risk.** If the Agent process and the
  MoneySwitch server run under the same OS user, the Agent already has
  shell access and can read the SQLite database or the encrypted wallet
  keystore file directly, or attach a debugger to the MoneySwitch process.
  The "the agent never gets the private key" guarantee only holds if
  MoneySwitch runs under a **separate OS user, a separate container, or a
  separate machine** from the Agent. This is a deployment recommendation,
  not something enforced by the code.
- **SSRF guard is literal/hostname matching, not a DNS-rebinding
  defense.** It blocks obvious loopback/private-network address literals
  and MoneySwitch's own listening address in common literal forms
  (`127.0.0.1`, `localhost`, `0.0.0.0`, `::1`), and only allows a
  private/loopback target when the MoneyKey's `allowed_hosts` explicitly
  lists that exact `host:port`. It does not re-resolve DNS names and
  re-check the resolved IP address before every request, so a DNS name
  that resolves to a public IP at allowlist time and a private IP at
  request time (DNS rebinding) is not defended against.
- **`unknown` payment status is counted as spent, conservatively.** If an
  upstream request's outcome can't be determined after a payment payload
  may have already been sent (timeout, dropped connection, an unparseable
  settlement header), MoneySwitch keeps the budget reservation and marks
  the payment `unknown` rather than `failed`. This can overcount usage; it
  deliberately never undercounts, since undercounting risks quietly
  exceeding a configured budget. Audit `unknown` payments manually via
  `GET /v1/admin/usage`.
- **Per-request limit alone does not stop many small payments.** An agent
  allowed to call `/v1/fetch` repeatedly can still drain the daily/total
  budget one small payment at a time. The real defenses are
  `allowed_hosts` (a small, explicit allowlist of reachable hosts), the
  daily budget, and `max_payments_per_minute` — not the per-request cap in
  isolation.
- **No rate limiting on admin-token guesses** beyond what your reverse
  proxy / Fastify defaults provide. Do not expose the Money API port to
  the public internet without a firewall or reverse proxy in front of it.

See [`docs/security.md`](docs/security.md) for the full threat model,
secrets-handling notes, and deployment recommendations.

## Supported versions

MoneySwitch is pre-1.0. Security fixes land on the `main` branch; there is
no separate long-term-support branch yet.
