import type { FastifyInstance } from "fastify";
import {
  checkRateLimit,
  assertNotSsrf,
  MoneySwitchError,
  ApprovalRequiredError,
  usedTotal,
  getKeyChain,
  effectiveAllowedModels,
  effectiveRemaining,
  limitFields,
  formatMicrosToUsdc,
  listEnabledModels,
  findChannelForModel,
  normalizeBaseUrl,
  recordPaymentUsage,
} from "@moneyswitch/core";
import { performPaidFetch, type Charged } from "@moneyswitch/x402";
import type { AppContext } from "../context.js";
import { requireMoneyKeyOpenAI, openAiError, openAiStatusForCode, humanMessageForCode } from "../auth.js";
import { paymentUnknownReason, bodyIncompleteReason } from "../paid-outcomes.js";

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
    // v0.4: intersection of the key's and all its ancestors' allowed_models.
    const allowed = effectiveAllowedModels(getKeyChain(ctx.db, key.id));
    const models = allowed == null ? allModels : allModels.filter((m) => allowed.includes(m));
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

    function sendPolicyError(
      code: string,
      message: string,
      approvalId?: string | null,
      limit?: { limit_scope?: string; limit_key_prefix?: string }
    ) {
      return reply.status(openAiStatusForCode(code)).send(openAiError(message, code, approvalId ?? null, limit));
    }

    if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
      return reply.status(400).send(openAiError("model and messages are required", "invalid_request"));
    }

    const channel = findChannelForModel(ctx.db, body.model);
    if (!channel) {
      return sendPolicyError("model_not_found", `The model '${body.model}' does not exist or is not served by any enabled channel`);
    }
    const allowedModels = effectiveAllowedModels(getKeyChain(ctx.db, key.id));
    if (allowedModels != null && !allowedModels.includes(body.model)) {
      return sendPolicyError("model_not_allowed", `MoneyKey is not allowed to use model '${body.model}'`);
    }

    // Updated as soon as performPaidFetch returns, so the catch-all below never
    // claims a call was free when it may not have been.
    let chargedSoFar: Charged = "no";
    try {
      checkRateLimit(ctx.db, key);

      const upstreamUrl = `${normalizeBaseUrl(channel.baseUrl)}/chat/completions`;
      const url = new URL(upstreamUrl);
      // Channel base_url host:port is auto-allowed for the gateway path (SPEC-v0.2
      // §1); the self-port SSRF rule still applies and cannot be bypassed.
      assertNotSsrf(url, {
        selfPort: ctx.config.port,
        allowedHosts: [...key.allowedHosts, `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`],
        // v0.5: a channel may be a toll booth on this same server (/t/…).
        allowSelfTollbooth: true,
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
      chargedSoFar = result.charged;

      if (result.paymentUnknown || result.bodyIncomplete) {
        // We signed a payment and then lost the answer (deadline / transport
        // error / body cut off after a confirmed settlement). This must NOT look
        // like an ordinary retryable upstream error: an OpenAI client retrying
        // would sign and pay a second time. So: a non-retryable 4xx status, an
        // explicit x-should-retry: false, and moneyswitch_charged in the error.
        const pay = result.payment;
        const amount = pay?.amount ?? "0";
        const code = result.paymentUnknown ? result.paymentUnknown.code : "UPSTREAM_BODY_INCOMPLETE";
        const reason = result.paymentUnknown
          ? paymentUnknownReason(result.paymentUnknown.code, amount, result.paymentUnknown.detail)
          : bodyIncompleteReason(amount, pay?.txHash ?? null, result.bodyIncomplete!.detail);
        reply.header("x-should-retry", "false");
        return reply.status(openAiStatusForCode(code)).send(
          openAiError(`${humanMessageForCode(code)}. ${reason}`, code, null, undefined, {
            reason,
            reserved_until_expiry: result.paymentUnknown ? true : undefined,
            moneyswitch_charged: result.charged,
            payment: pay ? { amount, tx_hash: pay.txHash, network: pay.network } : undefined,
          })
        );
      }

      if (result.paymentRejected) {
        // We signed and sent a payment but the seller answered 402 AGAIN, or its
        // facilitator reported the settlement failed / unconfirmed (PAYMENT-RESPONSE
        // success:false). Consistent with the other payment-failure paths above:
        // OpenAI-shaped error, reason surfaced, and NOT a retryable status (the
        // signed authorization may still settle, so a retry could pay twice — see
        // openAiStatusForCode). The reservation is kept `unknown` (not released)
        // until the signed authorization expires — see performPaidFetch/reconcile.ts.
        reply.header("x-should-retry", "false");
        return reply
          .status(openAiStatusForCode("PAYMENT_REJECTED"))
          .send(
            openAiError(humanMessageForCode("PAYMENT_REJECTED"), "PAYMENT_REJECTED", null, undefined, {
              reason: result.paymentRejected.reason,
              reserved_until_expiry: true,
              moneyswitch_charged: "maybe",
            })
          );
      }

      let upstreamJson: Record<string, unknown>;
      try {
        upstreamJson = JSON.parse(result.body);
      } catch {
        // The payment (if any) already happened: say so, and keep clients from retrying a charged call.
        if (result.charged !== "no") reply.header("x-should-retry", "false");
        return reply
          .status(502)
          .send(
            openAiError("Upstream returned a non-JSON response", "UPSTREAM_ERROR", null, undefined, {
              moneyswitch_charged: result.charged,
            })
          );
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
      const remainingToday = formatMicrosToUsdc(effectiveRemaining(ctx.db, getKeyChain(ctx.db, key.id)).today);

      reply.header("X-MoneySwitch-Cost", cost);
      if (txHash) reply.header("X-MoneySwitch-Tx", txHash);

      if (body.stream) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        interface UpstreamToolCall {
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }
        const choices =
          (upstreamJson.choices as
            | Array<{
                message?: { role?: string; content?: string | null; tool_calls?: UpstreamToolCall[] };
                finish_reason?: string;
              }>
            | undefined) ?? [];
        const message = choices[0]?.message;
        const role = message?.role ?? "assistant";
        const upstreamContent = message?.content;
        const toolCalls = Array.isArray(message?.tool_calls) && message!.tool_calls!.length > 0 ? message!.tool_calls! : null;
        // Upstream content is a string -> pass through; null with tool_calls present ->
        // null (OpenAI-shaped: assistant turns with only tool calls have no text);
        // anything else (missing, or null without tool_calls) -> "" as before.
        const content: string | null =
          typeof upstreamContent === "string" ? upstreamContent : upstreamContent === null && toolCalls ? null : "";
        const id = (upstreamJson.id as string) ?? `chatcmpl-${Date.now()}`;
        const created = (upstreamJson.created as number) ?? Math.floor(Date.now() / 1000);
        const model = (upstreamJson.model as string) ?? body.model;

        const delta: { role: string; content: string | null; tool_calls?: unknown[] } = { role, content };
        if (toolCalls) {
          delta.tool_calls = toolCalls.map((tc, i) => ({
            index: i,
            id: tc?.id,
            type: "function",
            function: { name: tc?.function?.name, arguments: tc?.function?.arguments },
          }));
        }

        const upstreamFinishReason = choices[0]?.finish_reason;
        const finishReason = typeof upstreamFinishReason === "string" && upstreamFinishReason.length > 0 ? upstreamFinishReason : "stop";

        const firstChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
        const finalChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        };
        reply.raw.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
        reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);

        const streamOptions = (body as { stream_options?: { include_usage?: boolean } }).stream_options;
        const upstreamUsage = upstreamJson.usage;
        if (streamOptions?.include_usage === true && upstreamUsage && typeof upstreamUsage === "object") {
          const usageChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: upstreamUsage,
          };
          reply.raw.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
        }

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
          charged: result.charged,
        },
      };
      return reply.send(responseBody);
    } catch (e) {
      if (e instanceof ApprovalRequiredError) {
        return sendPolicyError("APPROVAL_REQUIRED", "Payment requires manual approval", e.approvalId);
      }
      if (e instanceof MoneySwitchError) {
        const limit = limitFields(e);
        const message =
          limit.limit_scope === "ancestor"
            ? `${humanMessageForCode(e.code)} (limit set by parent key ${limit.limit_key_prefix})`
            : humanMessageForCode(e.code);
        return sendPolicyError(e.code, message, null, limit);
      }
      req.log.error({ err: (e as Error)?.message }, "unexpected /v1/chat/completions error");
      if (chargedSoFar !== "no") reply.header("x-should-retry", "false");
      return reply
        .status(openAiStatusForCode("UPSTREAM_ERROR"))
        .send(
          openAiError("Unexpected upstream error", "UPSTREAM_ERROR", null, undefined, { moneyswitch_charged: chargedSoFar })
        );
    }
  });
}
