#!/usr/bin/env node
import path from "node:path";
import OpenAI from "openai";
import { MoneySwitchClient } from "./moneyswitch.js";
import { runAgent } from "./agent.js";
import { Trace, writeTranscript } from "./trace.js";
import { makeRedactor } from "./redact.js";

const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_MODEL = "qwen3.8-max";
const DEFAULT_MAX_STEPS = 8;

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('Usage: node dist/cli.js "<question about Monad on-chain activity>"');
    process.exit(1);
  }

  const moneySwitchUrl = (process.env.MONEYSWITCH_URL || "http://127.0.0.1:4020").replace(/\/+$/, "");
  const moneyKey = process.env.MONEYKEY;
  const qwenApiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  const qwenBaseUrl = process.env.QWEN_BASE_URL || DEFAULT_QWEN_BASE_URL;
  const qwenModel = process.env.QWEN_MODEL || DEFAULT_QWEN_MODEL;
  const maxSteps = Number(process.env.AGENT_MAX_STEPS) > 0 ? Number(process.env.AGENT_MAX_STEPS) : DEFAULT_MAX_STEPS;

  if (!moneyKey) {
    console.error("MONEYKEY is required (mk_live_... from your MoneySwitch server).");
    process.exit(1);
  }
  if (!qwenApiKey) {
    console.error("QWEN_API_KEY (or DASHSCOPE_API_KEY) is required.");
    process.exit(1);
  }

  const redact = makeRedactor([moneyKey, qwenApiKey]);
  const trace = new Trace((line) => console.log(line), process.stdout.isTTY ?? false, redact);

  const moneySwitch = new MoneySwitchClient(moneySwitchUrl, moneyKey);
  const openai = new OpenAI({ apiKey: qwenApiKey, baseURL: qwenBaseUrl });

  trace.emit("plan", `Question: ${question}`);

  let result;
  try {
    result = await runAgent({ openai, model: qwenModel, moneySwitch, question, trace, maxSteps });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace.emit("error", `agent run failed: ${redact(msg)}`);
    result = { finalAnswer: null, hitStepLimit: false };
  }

  const repoDataDir = path.join(process.cwd(), ".data");
  const transcriptPath = writeTranscript(repoDataDir, question, trace, result.finalAnswer, redact);
  console.log(`(transcript written to ${transcriptPath})`);

  if (!result.finalAnswer) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[qwen-agent] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
