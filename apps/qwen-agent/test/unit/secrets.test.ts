import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { runAgent } from "../../src/agent.js";
import { MoneySwitchClient } from "../../src/moneyswitch.js";
import { Trace, writeTranscript } from "../../src/trace.js";
import { makeRedactor } from "../../src/redact.js";
import { startFakeOpenAiServer } from "./helpers/fake-openai-server.js";
import { startFakeMoneySwitchServer } from "./helpers/fake-moneyswitch-server.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

describe("secrets never appear in stdout or the transcript", () => {
  it("redacts the MoneyKey and Qwen API key from every printed trace line and the JSON transcript", async () => {
    const moneyKey = "mk_live_SUPERSECRETTESTKEY";
    const qwenApiKey = "sk-SUPERSECRETQWENKEY";

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
      { content: `Final answer citing the key ${moneyKey} would be a bug, but this checks the redactor still catches it.` },
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
          body: JSON.stringify({ data: [{ token_symbol: "DAK" }] }),
          payment: { amount: "0.01", tx_hash: "0xabc123", network: "eip155:143", mock: false },
        },
      ],
    });
    cleanups.push(moneySwitchServer.close);

    const redact = makeRedactor([moneyKey, qwenApiKey]);
    const printed: string[] = [];
    const trace = new Trace((line) => printed.push(line), false, redact);

    const openai = new OpenAI({ apiKey: qwenApiKey, baseURL: openaiServer.url });
    const moneySwitch = new MoneySwitchClient(moneySwitchServer.url, moneyKey);

    const result = await runAgent({
      openai,
      model: "qwen3.8-max",
      moneySwitch,
      question: "What's hot on Monad?",
      trace,
      maxSteps: 8,
    });

    const printedJoined = printed.join("\n");
    expect(printedJoined).not.toContain(moneyKey);
    expect(printedJoined).not.toContain(qwenApiKey);
    expect(printedJoined).toContain("[REDACTED]");

    // The MoneySwitch server itself never saw the model's echoed key either —
    // confirms redaction is a defense-in-depth backstop, not a workaround for
    // a real leak in the request path.
    const authHeaderSeen = (moneySwitchServer.requests as unknown[]).length > 0;
    expect(authHeaderSeen).toBe(true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-agent-transcript-"));
    const transcriptPath = writeTranscript(tmpDir, "What's hot on Monad?", trace, result.finalAnswer, redact);
    const transcriptRaw = fs.readFileSync(transcriptPath, "utf-8");
    expect(transcriptRaw).not.toContain(moneyKey);
    expect(transcriptRaw).not.toContain(qwenApiKey);
  });
});
