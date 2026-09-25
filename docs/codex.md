# Using MoneySwitch from Codex

1. Build the MCP server:

   ```bash
   pnpm --filter @moneyswitch/mcp build
   ```

2. Add to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.moneyswitch]
   command = "node"
   args = ["<abs>/apps/mcp/dist/index.js"]

   [mcp_servers.moneyswitch.env]
   MONEY_API_BASE = "http://127.0.0.1:4020"
   MONEY_API_KEY = "mk_live_xxx"
   ```

   Replace `<abs>` with the absolute path to this repo's
   `apps/mcp/dist/index.js`.

3. Same three tools as in `docs/claude.md`: `money_status`, `paid_fetch`,
   `money_history`. `paid_fetch` returning an `approval_required` result
   means a human must approve the payment (via the admin API or Dashboard)
   before Codex retries with the given `approval_id`.
