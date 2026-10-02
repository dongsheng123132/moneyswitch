#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatPaidFetchResult, formatPaidFetchTransportError } from "./paid-fetch-result.js";
import { parseTimeoutMs, requestMoneyApi } from "./money-api.js";

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

// status / history answer immediately.
const API_TIMEOUT_MS = parseTimeoutMs(process.env.MONEY_API_TIMEOUT_MS, 30_000);
// POST /v1/fetch answers only after the whole paid exchange: up to the server's probe deadline
// (MONEYSWITCH_PROBE_TIMEOUT_MS, 30 s) + paid deadline (MONEYSWITCH_PAID_TIMEOUT_MS, 300 s).
// Must stay above their sum, or this client gives up before the server's verdict arrives.
const FETCH_TIMEOUT_MS = parseTimeoutMs(process.env.MONEY_API_FETCH_TIMEOUT_MS, 600_000);

function callMoneyApi(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<{ status: number; json: any }> {
  return requestMoneyApi({ baseUrl: MONEY_API_BASE, path, method, apiKey: MONEY_API_KEY!, body, timeoutMs });
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
      "Fetch a URL through MoneySwitch, paying via x402 if required. Policy limits (per-request/daily/total budget, approval threshold, allowed hosts) are enforced by MoneySwitch, not the agent. " +
      "A paid call to a slow seller can take several minutes. If this tool times out, errors, or reports charged \"maybe\" / payment_unknown, the payment may still have gone through: " +
      "do NOT retry automatically, check money_history first.",
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
    let res: { status: number; json: any };
    try {
      res = await callMoneyApi(
        "POST",
        "/v1/fetch",
        {
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
          max_price: args.max_price,
          approval_id: args.approval_id,
        },
        FETCH_TIMEOUT_MS
      );
    } catch (e) {
      // The exchange with MoneySwitch broke. Unless the request never left this machine the
      // call may have been charged: say so (and do not throw a bare "fetch failed").
      return formatPaidFetchTransportError(e);
    }

    return formatPaidFetchResult(res.status, res.json);
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
