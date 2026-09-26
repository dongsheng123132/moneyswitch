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

No install needed. Until this package is published to the npm registry,
every MoneySwitch server (after `pnpm build`) serves it at
`/dl/moneyswitch.tgz`, so `npx` can run it straight from your server:

```bash
npx -y --package=http://127.0.0.1:4020/dl/moneyswitch.tgz moneyswitch connect \n  --server http://127.0.0.1:4020 --key mk_live_xxx --apply
```

Once published, the short form is `npx moneyswitch connect …`.

## Commands

```
moneyswitch connect --server <url> --key <mk_live_...> [--apply] [--json]
moneyswitch status  --server <url> --key <mk_live_...> [--json]
moneyswitch remove  [--apply] [--json]
moneyswitch ui      [--port 4318] [--no-open]
moneyswitch mcp
```

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

See the [main repository](https://github.com/dongsheng123132/moneyswitch)
for how to run a MoneySwitch server.

## License

Apache-2.0. See [LICENSE](./LICENSE).
