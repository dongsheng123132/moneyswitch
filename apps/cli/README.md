# moneyswitch

Give your AI an API key for money.

`moneyswitch` is the client-side CLI + [Model Context Protocol](https://modelcontextprotocol.io)
server for [MoneySwitch](https://github.com/dongsheng123132/moneyswitch): a
self-hosted gateway that lets an AI agent hold a `mk_live_…` "MoneyKey"
instead of a wallet private key, and spend USDC on the Monad testnet through
[x402](https://x402.org)-priced HTTP APIs, policy-checked (budgets,
per-request limits, host allowlist, human approval thresholds) before every
payment.

This package never touches a private key. It only talks to a MoneySwitch
server's HTTP API.

## Install

No install needed — it is on npm:

```bash
npx moneyswitch demo                     # 30-second offline tour, no real money
npx moneyswitch connect --server http://127.0.0.1:4020 --key mk_live_xxx --apply
npx moneyswitch sell --upstream http://127.0.0.1:8080 --pay-to 0xYourAddress --price 0.01
npx moneyswitch ui
```

Every MoneySwitch server built from the repository also serves this package
at `/dl/moneyswitch.tgz` (`npx -y --package=<server>/dl/moneyswitch.tgz moneyswitch …`),
for machines that cannot reach the npm registry.

## Commands

```
moneyswitch demo    [--port 4020] [--no-open] [--registry=<url>]
moneyswitch connect --server <url> --key <mk_live_...> [--apply] [--json]
moneyswitch status  --server <url> --key <mk_live_...> [--json]
moneyswitch remove  [--apply] [--json]
moneyswitch ui      [--port 4318] [--no-open]
moneyswitch sell    --upstream <url> --pay-to <0x…> [--price 0.01] [--route "POST /path=0.01"]...
moneyswitch mcp
moneyswitch --version
```

- `demo` runs `npx -y moneyswitch-server@<same version> demo`: it **downloads
  the separate `moneyswitch-server` package** (the self-hostable server +
  Dashboard, licensed **AGPL-3.0-only** — this CLI stays Apache-2.0 and does
  not include it) and starts a throwaway, fully offline MoneySwitch: mock
  wallet, a demo channel, two MoneyKeys, a toll booth and a few simulated
  payments, opened in your browser already signed in. Everything is labelled
  "DEMO · simulated settlement"; Ctrl+C stops it and deletes the data. If your
  npm mirror has not synced the package yet, add
  `--registry=https://registry.npmjs.org/`. `MONEYSWITCH_SERVER_SPEC` runs a
  different package spec (e.g. a local `.tgz`).
- `sell` puts a toll booth in front of your own API: AI agents pay USDC per
  call (x402) straight to your public receiving address; no MoneySwitch
  server needed. `moneyswitch sell --help` lists every option.
- `connect` detects Claude Code / Codex on this machine and (with `--apply`)
  wires up the MoneySwitch MCP server for you. Without `--apply` it only
  prints what it would do (dry run).
- `status` checks a MoneyKey's remaining budget against a running server.
- `remove` undoes what `connect --apply` did.
- `ui` opens a local desktop console on `http://127.0.0.1:4318` (loopback
  only, one-time login link, httpOnly session cookie). One card per agent
  (Claude Code, Codex; manual steps for OpenClaw / WorkBuddy / Cherry Studio)
  with a "brain" column (model provider + API key + model, with a connection
  test) and a "wallet" column (cut a child MoneyKey from yours via
  `POST /v1/keys/children`, or paste one). Enabling shows the exact config diff
  first, backs every file up as `<file>.bak-<timestamp>`, verifies by reading
  back, and rolls back on failure; disabling restores the original values.
  Your MoneyKey is stored in `~/.moneyswitch/desktop.json` (current user only);
  model keys are never sent to the MoneySwitch server. Formats and how they
  were verified: docs/desktop-agents.md in the main repository.
- `mcp` starts the stdio MCP server directly (this is what `connect` points
  Claude Code / Codex at — normally you never run it by hand). It reads
  `MONEY_API_BASE` and `MONEY_API_KEY` from the environment.

Run your own MoneySwitch server (separate package, AGPL-3.0-only):
`npx moneyswitch-server` — see the
[main repository](https://github.com/dongsheng123132/moneyswitch).

## License

Apache-2.0. See [LICENSE](./LICENSE).
