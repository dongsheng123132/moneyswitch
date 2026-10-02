#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatPaidFetchResult } from "./paid-fetch-result.js";

/**
 * MoneySwitch MCP server (SPEC §7): stdio, pure HTTP client against the
 * MoneySwitch Money API. Deliberately does NOT depend on @moneyswitch/wallet
 * or @moneyswitch/x402 — the agent process never touches keys or signing.
 */

const MONEY_API_BASE = process.env.MONEY_API_BASE || "http://127.0.0.1:4020";
const MONEY_API_KEY = process.env.MONEY_API_KEY;

if (!MONEY_API_KEY) {
  console.error("[moneyswitch-mcp] MONEY_API_KEY env var is required (mk_live_xxx)");
  process.exit(1);
}

async function callMoneyApi(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${MONEY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MONEY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const server = new McpServer({
  name: "moneyswitch",
  version: "0.1.0",
});

server.registerTool(
  "money_status",
  {
    title: "MoneySwitch status",
    description: "Get remaining budget (today/total), per-request limit, currency and network for this MoneyKey.",
    inputSchema: {},
  },
  async () => {
    const { status, json } = await callMoneyApi("GET", "/v1/status");
    if (status !== 200) {
      return { content: [{ type: "text", text: `Error fetching status (HTTP ${status}): ${JSON.stringify(json)}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }
);

server.registerTool(
  "paid_fetch",
  {
    title: "Paid fetch via MoneySwitch",
    description:
      "Fetch a URL through MoneySwitch, paying via x402 if required. Policy limits (per-request/daily/total budget, approval threshold, allowed hosts) are enforced by MoneySwitch, not the agent.",
    inputSchema: {
      url: z.string().url(),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
      max_price: z.string().optional().describe('Optional cap as decimal USDC string, e.g. "0.05"'),
      approval_id: z.string().optional().describe("Approval id from a previous approval_required response, after the user has approved it"),
    },
  },
  async (args) => {
    const { status, json } = await callMoneyApi("POST", "/v1/fetch", {
      url: args.url,
      method: args.method,
      headers: args.headers,
      body: args.body,
      max_price: args.max_price,
      approval_id: args.approval_id,
    });

    return formatPaidFetchResult(status, json);
  }
);

server.registerTool(
  "money_history",
  {
    title: "MoneySwitch payment history",
    description: "List recent payments made by this MoneyKey.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional(),
    },
  },
  async (args) => {
    const qs = args.limit ? `?limit=${args.limit}` : "";
    const { status, json } = await callMoneyApi("GET", `/v1/history${qs}`);
    if (status !== 200) {
      return { content: [{ type: "text", text: `Error fetching history (HTTP ${status}): ${JSON.stringify(json)}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[moneyswitch-mcp] connected via stdio");
}

main().catch((err) => {
  console.error("[moneyswitch-mcp] fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
