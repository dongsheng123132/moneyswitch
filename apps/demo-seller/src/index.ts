import express from "express";
import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { TESTNET } from "@moneyswitch/x402";
import { parseUsdcToMicros } from "@moneyswitch/core";

const PORT = Number(process.env.DEMO_SELLER_PORT || 4021);
const PAY_TO = process.env.DEMO_SELLER_PAY_TO;
const FACILITATOR_URL = process.env.DEMO_SELLER_FACILITATOR_URL || TESTNET.facilitatorUrl;

// SPEC-v0.2 §3: demo-seller as an LLM channel. `moneyswitch-demo-chat` is the
// only model served at GET/POST /v1/models, /v1/chat/completions. Priced
// 0.01 USDC/call (exact), same x402 flow as the other routes below.
const DEMO_MODEL_ID = "moneyswitch-demo-chat";
const DEMO_LLM_UPSTREAM_KEY = process.env.DEMO_LLM_UPSTREAM_KEY;
const DEMO_LLM_UPSTREAM_MODEL = process.env.DEMO_LLM_UPSTREAM_MODEL || "deepseek/deepseek-v4.1-flash";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

if (!PAY_TO) {
  console.error("[demo-seller] DEMO_SELLER_PAY_TO env var is required (must NOT equal MoneySwitch's wallet address)");
  process.exit(1);
}

const scheme = new ExactEvmScheme();
// Testnet USDC is not in the SDK's default asset table (SPEC §1 / PR #3570
// unmerged), so a custom money parser must be registered to convert decimal
// price strings ("0.01") into the atomic amount + asset + EIP-712 domain
// extra, per https://docs.monad.xyz/guides/x402
scheme.registerMoneyParser(async (amount) => {
  return {
    amount: parseUsdcToMicros(String(amount)).toString(),
    asset: TESTNET.usdcAddress,
    extra: { name: TESTNET.usdcDomainName, version: TESTNET.usdcDomainVersion },
  };
});

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  TESTNET.caip2 as `${string}:${string}`,
  scheme
);

const routes: RoutesConfig = {
  "GET /premium-report": {
    accepts: { scheme: "exact", payTo: PAY_TO, price: "0.01", network: TESTNET.caip2 as `${string}:${string}` },
    description: "Premium report — normal payment demo",
  },
  "GET /deep-report": {
    accepts: { scheme: "exact", payTo: PAY_TO, price: "0.15", network: TESTNET.caip2 as `${string}:${string}` },
    description: "Deep report — priced above the demo key's approval_threshold to trigger APPROVAL_REQUIRED",
  },
  "GET /greedy": {
    accepts: { scheme: "exact", payTo: PAY_TO, price: "5.00", network: TESTNET.caip2 as `${string}:${string}` },
    description: "Greedy endpoint — priced above the demo key's per_request_limit",
  },
  "POST /v1/chat/completions": {
    accepts: { scheme: "exact", payTo: PAY_TO, price: "0.01", network: TESTNET.caip2 as `${string}:${string}` },
    description: "OpenAI-compatible chat completion — 0.01 USDC/call (SPEC-v0.2 §3)",
  },
};

const app = express();
app.use(express.json());

app.get("/free", (_req, res) => {
  res.json({ free: true, message: "no payment required" });
});

// SPEC-v0.2 §3: GET /v1/models is free (only lists what this demo-seller serves).
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: DEMO_MODEL_ID, object: "model", created: 0, owned_by: "moneyswitch-demo" }],
  });
});

app.use(paymentMiddleware(routes, resourceServer));

app.get("/premium-report", (_req, res) => {
  res.json({ report: "premium content", price: "0.01" });
});
app.get("/deep-report", (_req, res) => {
  res.json({ report: "deep content", price: "0.15" });
});
app.get("/greedy", (_req, res) => {
  res.json({ report: "should never be reached by demo key", price: "5.00" });
});

interface IncomingChatMessage {
  role: string;
  content: string;
}

function lastUserMessage(messages: IncomingChatMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return String(messages[i].content ?? "");
  }
  return messages.length > 0 ? String(messages[messages.length - 1]?.content ?? "") : "";
}

function pseudoTokenCount(text: string): number {
  // Deterministic, offline-only approximation — never used for real billing
  // (x402 price is fixed at 0.01/call regardless of token count).
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * SPEC-v0.2 §3: echo mode (no DEMO_LLM_UPSTREAM_KEY) returns a deterministic
 * reply for offline tests/e2e. OpenRouter mode forwards to OpenRouter with
 * DEMO_LLM_UPSTREAM_MODEL, forcing stream:false regardless of what the
 * caller asked for (MoneySwitch's own gateway already forces stream:false,
 * but demo-seller may also be called directly).
 */
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body as { model?: string; messages?: IncomingChatMessage[] };
  const requestedModel = body.model || DEMO_MODEL_ID;
  const id = `chatcmpl-demo-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!DEMO_LLM_UPSTREAM_KEY) {
    const userText = lastUserMessage(body.messages);
    const content = `[demo] You said: ${userText}`;
    const promptTokens = pseudoTokenCount(userText);
    const completionTokens = pseudoTokenCount(content);
    res.json({
      id,
      object: "chat.completion",
      created,
      model: requestedModel,
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
    return;
  }

  try {
    const upstreamRes = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Never logged: only ever placed in this one outbound request header.
        authorization: `Bearer ${DEMO_LLM_UPSTREAM_KEY}`,
      },
      body: JSON.stringify({ ...body, model: DEMO_LLM_UPSTREAM_MODEL, stream: false }),
    });
    const upstreamJson = await upstreamRes.json();
    if (!upstreamRes.ok) {
      res.status(upstreamRes.status).json(upstreamJson);
      return;
    }
    res.json(upstreamJson);
  } catch (e) {
    res.status(502).json({ error: { message: "OpenRouter upstream request failed", type: "upstream_error" } });
  }
});

async function assertOpenRouterModelAvailable(): Promise<void> {
  if (!DEMO_LLM_UPSTREAM_KEY) return;
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { authorization: `Bearer ${DEMO_LLM_UPSTREAM_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`OpenRouter /models returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (json.data ?? []).map((m) => m.id);
    if (!ids.includes(DEMO_LLM_UPSTREAM_MODEL)) {
      console.error(
        `[demo-seller] DEMO_LLM_UPSTREAM_MODEL="${DEMO_LLM_UPSTREAM_MODEL}" is not available on OpenRouter. ` +
          `Set DEMO_LLM_UPSTREAM_MODEL to one of the models returned by ${OPENROUTER_MODELS_URL} and restart.`
      );
      process.exit(1);
    }
  } catch (e) {
    console.error(
      `[demo-seller] Failed to verify DEMO_LLM_UPSTREAM_MODEL against OpenRouter: ${
        e instanceof Error ? e.message : e
      }`
    );
    process.exit(1);
  }
}

assertOpenRouterModelAvailable().then(() => {
  app.listen(PORT, () => {
    console.log(`[demo-seller] listening on :${PORT}, payTo=${PAY_TO}, facilitator=${FACILITATOR_URL}`);
  });
});
