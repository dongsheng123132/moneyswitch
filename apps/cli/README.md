# moneyswitch

Apache-2.0 client CLI and stdio MCP adapter for MoneySwitch.

Skill + a budgeted MoneyKey is the primary integration. Copy your personalized skill from your self-hosted Dashboard. The agent never needs a wallet private key.

Commands in this version:

```sh
moneyswitch mcp
moneyswitch demo
moneyswitch --help
moneyswitch --version
```

The MCP adapter reads `MONEY_API_BASE` and `MONEY_API_KEY` from its environment. Configure these through your agent's private configuration. The demo uses the separately packaged AGPL-3.0-only `moneyswitch-server`; it simulates settlement and uses disposable data.

v0.6 removes `connect`, `status`, `remove`, `ui` and `sell`. Status/history are HTTP API and MCP operations, described in the skill. This version does not edit agent configuration or operate a seller paywall.

Build this source with `pnpm build`. Older npm releases do not contain unpublished source changes.
