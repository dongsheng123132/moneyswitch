import express from "express";
import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { TESTNET } from "@moneyswitch/x402";
import { parseUsdcToMicros } from "@moneyswitch/core";

// SPEC-v0.2 §3: demo-seller as an LLM channel. `moneyswitch-demo-chat` is the
// only model served at GET/POST /v1/models, /v1/chat/completions. Priced
// 0.01 USDC/call (exact), same x402 flow as the other routes below.
export const DEMO_MODEL_ID = "moneyswitch-demo-chat";
export const DEFAULT_UPSTREAM_MODEL = "deepseek/deepseek-v4.1-flash";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface DemoSellerOptions {
  /** Receiving address for every paid route (must NOT equal MoneySwitch's wallet address). */
  payTo: string;
  /** x402 facilitator (the offline mock-facilitator in demos/tests). */
  facilitatorUrl?: string;
  /** OpenRouter key; unset = offline echo mode for /v1/chat/completions. */
  upstreamKey?: string;
  upstreamModel?: string;
}

/**
 * Builds the demo x402 seller as an Express app (not listening yet). Used by
 * ./index.ts (env-driven `node dist/index.js`) and by the offline demo in the
 * `moneyswitch-server` npm package, which runs it in-process.
 */
export function createDemoSellerApp(opts: DemoSellerOptions): express.Express {
  const PAY_TO = opts.payTo;
  const FACILITATOR_URL = opts.facilitatorUrl || TESTNET.facilitatorUrl;
  const DEMO_LLM_UPSTREAM_KEY = opts.upstreamKey;
  const DEMO_LLM_UPSTREAM_MODEL = opts.upstreamModel || DEFAULT_UPSTREAM_MODEL;

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

  // A plain, UNPRICED JSON API: the upstream a MoneySwitch toll booth is put in
  // front of in the offline demo (`moneyswitch-server demo`). It is free here on
  // purpose — the toll booth is what charges for it.
  app.get("/weather", (req, res) => {
    const city = typeof req.query.city === "string" && req.query.city.trim() ? req.query.city.trim().slice(0, 40) : "Shanghai";
    let h = 0;
    for (const ch of city) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    res.json({ city, forecast: ["sunny", "cloudy", "light rain", "windy"][h % 4], temp_c: 12 + (h % 18), source: "moneyswitch demo upstream" });
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

  return app;
}

/** Fails fast (throws) when upstreamKey is set but the model isn't served by OpenRouter. */
export async function assertOpenRouterModelAvailable(upstreamKey: string | undefined, upstreamModel: string = DEFAULT_UPSTREAM_MODEL): Promise<void> {
  if (!upstreamKey) return;
  let ids: string[];
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { authorization: `Bearer ${upstreamKey}` },
    });
    if (!res.ok) {
      throw new Error(`OpenRouter /models returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    ids = (json.data ?? []).map((m) => m.id);
  } catch (e) {
    throw new Error(`Failed to verify DEMO_LLM_UPSTREAM_MODEL against OpenRouter: ${e instanceof Error ? e.message : e}`);
  }
  if (!ids.includes(upstreamModel)) {
    throw new Error(
      `DEMO_LLM_UPSTREAM_MODEL="${upstreamModel}" is not available on OpenRouter. ` +
        `Set DEMO_LLM_UPSTREAM_MODEL to one of the models returned by ${OPENROUTER_MODELS_URL} and restart.`
    );
  }
}
