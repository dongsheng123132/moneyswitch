#!/usr/bin/env node
/**
 * Minimal MCP client that spawns apps/mcp/dist/index.js over stdio and calls
 * all three tools (money_status, paid_fetch, money_history), printing the
 * raw JSON-RPC results. Used as M4 acceptance evidence per SPEC.md §11.
 *
 * Usage:
 *   MONEY_API_BASE=http://127.0.0.1:4020 MONEY_API_KEY=mk_live_xxx \
 *     node scripts/mcp-client-check.mjs <fetch-url>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpEntry = path.resolve(__dirname, "../apps/mcp/dist/index.js");

const fetchUrl = process.argv[2] || "http://127.0.0.1:4021/free";

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: {
      MONEY_API_BASE: process.env.MONEY_API_BASE || "http://127.0.0.1:4020",
      MONEY_API_KEY: process.env.MONEY_API_KEY || "",
    },
  });

  const client = new Client({ name: "moneyswitch-check-client", version: "0.1.0" });
  await client.connect(transport);

  console.log("=== tools/list ===");
  const tools = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));

  console.log("\n=== money_status ===");
  const status = await client.callTool({ name: "money_status", arguments: {} });
  console.log(JSON.stringify(status, null, 2));

  console.log(`\n=== paid_fetch(${fetchUrl}) ===`);
  const paidFetch = await client.callTool({
    name: "paid_fetch",
    arguments: { url: fetchUrl },
  });
  console.log(JSON.stringify(paidFetch, null, 2));

  console.log("\n=== money_history ===");
  const history = await client.callTool({ name: "money_history", arguments: { limit: 10 } });
  console.log(JSON.stringify(history, null, 2));

  await client.close();
}

main().catch((err) => {
  console.error("mcp-client-check failed:", err);
  process.exit(1);
});
