# Using MoneySwitch from Claude Code

1. Build the MCP server:

   ```bash
   pnpm --filter @moneyswitch/mcp build
   ```

2. Register it (adjust the absolute path and your MoneyKey):

   ```bash
   claude mcp add moneyswitch \
     -e MONEY_API_BASE=http://127.0.0.1:4020 \
     -e MONEY_API_KEY=mk_live_xxx \
     -- node <abs>/apps/mcp/dist/index.js
   ```

   Replace `<abs>` with the absolute path to this repo, e.g.
   `C:/1mineyswitch/apps/mcp/dist/index.js` (Windows) or
   `/path/to/1mineyswitch/apps/mcp/dist/index.js` (Unix).

3. Three tools become available to Claude:
   - `money_status` — remaining daily/total budget, per-request limit, network.
   - `paid_fetch` — fetch a URL through MoneySwitch, paying via x402 if the
     resource requires it. If a payment needs manual approval, the tool
     result text will say so and give you an `approval_id`; approve it via
     the admin API (`POST /v1/approvals/:id/approve`) or the Dashboard
     (when built), then ask Claude to retry `paid_fetch` with the same
     `url`/`method`/`body` plus that `approval_id`.
   - `money_history` — recent payments made by this MoneyKey.

4. The MoneyKey (`mk_live_xxx`) only ever sees the Money API's HTTP
   surface — it cannot reach the admin routes, the wallet, or the private
   key.
