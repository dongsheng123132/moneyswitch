import { describe, it, expect, afterEach } from "vitest";
import OpenAI from "openai";
import { runAgent } from "../../src/agent.js";
import { MoneySwitchClient } from "../../src/moneyswitch.js";
import { Trace } from "../../src/trace.js";
import { startFakeOpenAiServer } from "./helpers/fake-openai-server.js";
import { startFakeMoneySwitchServer } from "./helpers/fake-moneyswitch-server.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

describe("runAgent happy path", () => {
  it("plans, checks budget, buys token-screener, and produces a final answer citing the tx hash", async () => {
    const openaiServer = await startFakeOpenAiServer([
      {
        content: "Plan: check budget, then buy the cheapest endpoint (token-screener) for 24h Monad activity.",
        toolCalls: [{ id: "call_1", name: "money_status", arguments: {} }],
      },
      {
        toolCalls: [
          {
            id: "call_2",
            name: "nansen_query",
            arguments: { endpoint: "token-screener", params: { chains: ["monad"], timeframe: "24h" } },
          },
        ],
      },
      {
        content:
          "DAK is hot on Monad in the last 24h. Data bought: token-screener ($0.01 USDC). " +
          "Total spent: 0.01 USDC. Tx: https://monadvision.com/tx/0xabc123.",
      },
    ]);
    cleanups.push(openaiServer.close);

    const moneySwitchServer = await startFakeMoneySwitchServer({
      status: {
        remaining_today: "5.00",
        remaining_total: "50.00",
        per_request_limit: "1.00",
        currency: "USDC",
        network: "eip155:143",
        key_name: "test-key",
      },
      fetchEnvelopes: [
        {
          status: "ok",
          http_status: 200,
          body: JSON.stringify({ data: [{ token_symbol: "DAK", price_usd: 1.2, volume_24h: 999999 }] }),
          payment: { amount: "0.01", tx_hash: "0xabc123", network: "eip155:143", mock: false },
          remaining_today: "4.99",
          remaining_total: "49.99",
        },
      ],
    });
    cleanups.push(moneySwitchServer.close);

    const openai = new OpenAI({ apiKey: "fake-qwen-key", baseURL: openaiServer.url });
    const moneySwitch = new MoneySwitchClient(moneySwitchServer.url, "mk_live_faketestkey");
    const trace = new Trace(() => {});

    const result = await runAgent({
      openai,
      model: "qwen3.8-max",
      moneySwitch,
      question: "What's hot on Monad in the last 24h and is smart money buying it?",
      trace,
      maxSteps: 8,
    });

    expect(result.hitStepLimit).toBe(false);
    expect(result.finalAnswer).toContain("0xabc123");

    // MoneySwitch actually received a POST to the catalog's token-screener
    // path with the catalog price as max_price.
    const fetchReq = moneySwitchServer.requests[0] as { url: string; max_price: string; body: unknown };
    expect(fetchReq.url).toBe("https://api.nansen.ai/api/v1/token-screener");
    expect(fetchReq.max_price).toBe("0.01");
    expect(fetchReq.body).toEqual({ chains: ["monad"], timeframe: "24h" });

    const kinds = trace.toJSON().map((e) => e.kind);
    expect(kinds).toEqual(["plan", "tool_call", "tool_call", "payment", "data", "final"]);
  });
});
