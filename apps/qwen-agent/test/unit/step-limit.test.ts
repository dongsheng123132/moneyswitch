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

describe("runAgent AGENT_MAX_STEPS hard stop", () => {
  it("stops after maxSteps turns even if the model never stops calling tools", async () => {
    // Every turn keeps calling money_status forever — the fake server repeats
    // the last scripted turn once it runs out, so a single always-calling
    // turn is enough.
    const openaiServer = await startFakeOpenAiServer([
      { toolCalls: [{ id: "call_x", name: "money_status", arguments: {} }] },
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
      fetchEnvelopes: [],
    });
    cleanups.push(moneySwitchServer.close);

    const openai = new OpenAI({ apiKey: "fake-qwen-key", baseURL: openaiServer.url });
    const moneySwitch = new MoneySwitchClient(moneySwitchServer.url, "mk_live_faketestkey");
    const trace = new Trace(() => {});

    const result = await runAgent({
      openai,
      model: "qwen3.8-max",
      moneySwitch,
      question: "Loop forever?",
      trace,
      maxSteps: 3,
    });

    expect(result.hitStepLimit).toBe(true);
    expect(result.finalAnswer).toBeNull();
    expect(openaiServer.callCount()).toBe(3);
    const lastEvent = trace.toJSON()[trace.toJSON().length - 1];
    expect(lastEvent.kind).toBe("error");
    expect(lastEvent.message).toMatch(/AGENT_MAX_STEPS/);
  });
});
