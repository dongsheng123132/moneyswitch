import { describe, it, expect, afterEach } from "vitest";
import OpenAI from "openai";
import { runAgent } from "../../src/agent.js";
import { MoneySwitchClient } from "../../src/moneyswitch.js";
import { Trace } from "../../src/trace.js";
import { startFakeOpenAiServer } from "./helpers/fake-openai-server.js";
import { startFakeMoneySwitchServer, type FakeFetchEnvelope } from "./helpers/fake-moneyswitch-server.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function runWithEnvelope(fetchEnvelope: FakeFetchEnvelope, finalContent: string) {
  const openaiServer = await startFakeOpenAiServer([
    {
      content: "Plan: buy token-screener.",
      toolCalls: [
        {
          id: "call_1",
          name: "nansen_query",
          arguments: { endpoint: "token-screener", params: { chains: ["monad"], timeframe: "24h" } },
        },
      ],
    },
    { content: finalContent },
  ]);
  cleanups.push(openaiServer.close);

  const moneySwitchServer = await startFakeMoneySwitchServer({
    status: {
      remaining_today: "0.00",
      remaining_total: "50.00",
      per_request_limit: "1.00",
      currency: "USDC",
      network: "eip155:143",
      key_name: "test-key",
    },
    fetchEnvelopes: [fetchEnvelope],
  });
  cleanups.push(moneySwitchServer.close);

  const openai = new OpenAI({ apiKey: "fake-qwen-key", baseURL: openaiServer.url });
  const moneySwitch = new MoneySwitchClient(moneySwitchServer.url, "mk_live_faketestkey");
  const trace = new Trace(() => {});

  const result = await runAgent({
    openai,
    model: "qwen3.8-max",
    moneySwitch,
    question: "What's hot on Monad?",
    trace,
    maxSteps: 8,
  });

  return { result, trace };
}

describe("runAgent adapts to non-ok envelopes instead of crashing", () => {
  it("surfaces a `denied` BUDGET envelope to the model as information", async () => {
    const { result, trace } = await runWithEnvelope(
      { status: "denied", code: "DAILY_BUDGET_EXCEEDED", remaining_today: "0.00", remaining_total: "50.00" },
      "Budget for today is exhausted, so I could not buy token-screener data. Answering with no purchased data."
    );

    expect(result.finalAnswer).toMatch(/exhausted|no purchased data/i);
    const errorEvents = trace.toJSON().filter((e) => e.kind === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(errorEvents)).toContain("DAILY_BUDGET_EXCEEDED");
  });

  it("surfaces a `payment_failed` PAYMENT_REJECTED envelope to the model as information", async () => {
    const { result, trace } = await runWithEnvelope(
      {
        status: "payment_failed",
        code: "PAYMENT_REJECTED",
        reason: "insufficient_funds",
        remaining_today: "0.00",
        remaining_total: "50.00",
      },
      "The seller rejected our payment (insufficient_funds), so I have no purchased data to report."
    );

    expect(result.finalAnswer).toMatch(/rejected|insufficient_funds/i);
    const errorEvents = trace.toJSON().filter((e) => e.kind === "error");
    expect(JSON.stringify(errorEvents)).toContain("PAYMENT_REJECTED");
    expect(JSON.stringify(errorEvents)).toContain("insufficient_funds");
  });

  it("tells the model a 4xx-after-reservation (payment null, http_status >= 400, status ok) was HELD, not spent", async () => {
    const { result, trace } = await runWithEnvelope(
      {
        status: "ok",
        code: null,
        http_status: 422,
        payment: null,
        body: JSON.stringify({ error: "Field 'timeframe' is not recognized", error_code: "unknown_field" }),
        remaining_today: "0.00",
        remaining_total: "50.00",
      },
      "The upstream request was rejected (422, unrecognized field); the reserved amount was only HELD, not spent, so I have no purchased data to report."
    );

    expect(result.finalAnswer).toMatch(/held|not spent/i);

    // The tool result content fed back to the model must carry the
    // "held, not spent" wording and the upstream error message.
    expect(result.finalAnswer).toBeDefined();
    const toolCallEvents = trace.toJSON().filter((e) => e.kind === "tool_call");
    expect(toolCallEvents.length).toBeGreaterThan(0);

    const errorEvents = trace.toJSON().filter((e) => e.kind === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(errorEvents)).toMatch(/422/);
    expect(JSON.stringify(errorEvents)).toContain("Field 'timeframe' is not recognized");
    expect(JSON.stringify(errorEvents)).toMatch(/HELD/);
    expect(JSON.stringify(errorEvents)).toMatch(/not charged/i);
  });
});
