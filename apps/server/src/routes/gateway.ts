import type { FastifyInstance } from "fastify";
import {
  checkRateLimit,
  assertNotSsrf,
  MoneySwitchError,
  ApprovalRequiredError,
  usedToday,
  usedTotal,
  formatMicrosToUsdc,
  listEnabledModels,
  findChannelForModel,
  normalizeBaseUrl,
  recordPaymentUsage,
} from "@moneyswitch/core";
import { performPaidFetch } from "@moneyswitch/x402";
import type { AppContext } from "../context.js";
import { requireMoneyKeyOpenAI, openAiError, openAiStatusForCode, humanMessageForCode } from "../auth.js";

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionsBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * SPEC-v0.2 §2: OpenAI-compatible gateway. MoneyKey-authenticated (Bearer),
 * reuses the SAME performPaidFetch/evaluateAndReserveInTransaction policy +
 * x402 machinery as /v1/fetch (packages/x402/src/client.ts) — no separate
 * payment logic. This route's job is purely: resolve model -> channel,
 * shape the request/response as OpenAI Chat Completions, and translate
 * policy errors into OpenAI-shaped error bodies.
 */
export function registerGatewayRoutes(app: FastifyInstance, ctx: AppContext) {
  const keyGuard = requireMoneyKeyOpenAI(ctx);

  app.get("/v1/models", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const allModels = listEnabledModels(ctx.db);
    const models = key.allowedModels == null ? allModels : allModels.filter((m) => key.allowedModels!.includes(m));
    return reply.send({
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "moneyswitch",
      })),
    });
  });

  app.get("/v1/dashboard/billing/subscription", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const totalBudgetUsd = Number(formatMicrosToUsdc(key.totalBudget));
    const accessUntil = key.expiresAt ? Math.floor(new Date(key.expiresAt).getTime() / 1000) : 0;
    return reply.send({
      object: "billing_subscription",
      has_payment_method: true,
      soft_limit_usd: totalBudgetUsd,
      hard_limit_usd: totalBudgetUsd,
      system_hard_limit_usd: totalBudgetUsd,
      access_until: accessUntil,
    });
  });

  app.get("/v1/dashboard/billing/usage", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const totalUsedMicros = usedTotal(ctx.db, key.id);
    // micro-USDC -> USD cents: divide by 1e6 (micros->USD), multiply by 100 (USD->cents) == divide by 1e4.
    const totalUsageCents = Number(totalUsedMicros) / 10_000;
    return reply.send({
      object: "list",
      total_usage: totalUsageCents,
    });
  });

  app.post("/v1/chat/completions", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const body = req.body as ChatCompletionsBody;

    function sendPolicyError(code: string, message: string, approvalId?: string | null) {
      return reply.status(openAiStatusForCode(code)).send(openAiError(message, code, approvalId ?? null));
    }

    if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
      return reply.status(400).send(openAiError("model and messages are required", "invalid_request"));
    }

    const channel = findChannelForModel(ctx.db, body.model);
    if (!channel) {
      return sendPolicyError("model_not_found", `The model '${body.model}' does not exist or is not served by any enabled channel`);
    }
    if (key.allowedModels != null && !key.allowedModels.includes(body.model)) {
      return sendPolicyError("model_not_allowed", `MoneyKey is not allowed to use model '${body.model}'`);
    }

    try {
      checkRateLimit(ctx.db, key);

      const upstreamUrl = `${normalizeBaseUrl(channel.baseUrl)}/chat/completions`;
      const url = new URL(upstreamUrl);
      // Channel base_url host:port is auto-allowed for the gateway path (SPEC-v0.2
      // §1); the self-port SSRF rule still applies and cannot be bypassed.
      assertNotSsrf(url, {
        selfPort: ctx.config.port,
        allowedHosts: [...key.allowedHosts, `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`],
      });

      if (!ctx.wallet.isUnlocked()) {
        return sendPolicyError("WALLET_LOCKED", "Wallet is locked");
      }
      const signer = ctx.wallet.getSigner()!;

      // Step 3: always force stream:false to the upstream (SPEC-v0.2 §2 step 3).
      // approval_id is MoneySwitch's own retry field, never forwarded: the
      // approval binds the sha256 of the upstream body, so forwarding it would
      // make the approved retry's body differ from the originally-held one and
      // every approved chat payment would fail with APPROVAL_INVALID
      // (found in the docs/ux-audit.md walkthrough, B-3).
      const { approval_id: approvalIdFromBody, ...forwardBody } = body as ChatCompletionsBody & { approval_id?: string };
      const upstreamBody = { ...forwardBody, stream: false };

      const result = await performPaidFetch(ctx.db, ctx.sqlite, key, signer, {
        url: upstreamUrl,
        host: url.hostname + ":" + (url.port || (url.protocol === "https:" ? 443 : 80)),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: upstreamBody,
        approvalId: typeof approvalIdFromBody === "string" ? approvalIdFromBody : null,
        kind: "chat",
        model: body.model,
      });

      let upstreamJson: Record<string, unknown>;
      try {
        upstreamJson = JSON.parse(result.body);
      } catch {
        return reply.status(502).send(openAiError("Upstream returned a non-JSON response", "UPSTREAM_ERROR"));
      }

      const usage = upstreamJson.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (result.paymentId && usage) {
        recordPaymentUsage(ctx.db, result.paymentId, {
          promptTokens: usage.prompt_tokens ?? null,
          completionTokens: usage.completion_tokens ?? null,
        });
      }

      const cost = result.payment?.amount ?? "0";
      const txHash = result.payment?.txHash ?? null;
      const network = result.payment?.network ?? null;
      const remainingToday = formatMicrosToUsdc(key.dailyBudget - usedToday(ctx.db, key.id));

      reply.header("X-MoneySwitch-Cost", cost);
      if (txHash) reply.header("X-MoneySwitch-Tx", txHash);

      if (body.stream) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const choices = (upstreamJson.choices as Array<{ message?: { role?: string; content?: string } }>) ?? [];
        const content = choices[0]?.message?.content ?? "";
        const role = choices[0]?.message?.role ?? "assistant";
        const id = (upstreamJson.id as string) ?? `chatcmpl-${Date.now()}`;
        const created = (upstreamJson.created as number) ?? Math.floor(Date.now() / 1000);
        const model = (upstreamJson.model as string) ?? body.model;

        const firstChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role, content }, finish_reason: null }],
        };
        const finalChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        reply.raw.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
        reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return;
      }

      const responseBody = {
        ...upstreamJson,
        moneyswitch: {
          cost,
          currency: "USDC",
          tx_hash: txHash,
          network,
          remaining_today: remainingToday,
        },
      };
      return reply.send(responseBody);
    } catch (e) {
      if (e instanceof ApprovalRequiredError) {
        return sendPolicyError("APPROVAL_REQUIRED", "Payment requires manual approval", e.approvalId);
      }
      if (e instanceof MoneySwitchError) {
        return sendPolicyError(e.code, humanMessageForCode(e.code));
      }
      req.log.error({ err: (e as Error)?.message }, "unexpected /v1/chat/completions error");
      return sendPolicyError("UPSTREAM_ERROR", "Unexpected upstream error");
    }
  });
}
