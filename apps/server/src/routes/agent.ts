import type { FastifyInstance } from "fastify";
import {
  checkRateLimit,
  checkHostAllowed,
  assertNotSsrf,
  MoneySwitchError,
  ApprovalRequiredError,
  usedToday,
  usedTotal,
  formatMicrosToUsdc,
  parseUsdcToMicros,
  listHistoryForKey,
} from "@moneyswitch/core";
import { performPaidFetch } from "@moneyswitch/x402";
import type { AppContext } from "../context.js";
import { requireMoneyKey } from "../auth.js";

const DENIED_CODES = new Set([
  "RATE_LIMITED",
  "HOST_NOT_ALLOWED",
  "SSRF_BLOCKED",
  "UNSUPPORTED_PAYMENT",
  "PER_REQUEST_LIMIT_EXCEEDED",
  "MAX_PRICE_EXCEEDED",
  "DAILY_BUDGET_EXCEEDED",
  "TOTAL_BUDGET_EXCEEDED",
  "APPROVAL_INVALID",
]);

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext) {
  const keyGuard = requireMoneyKey(ctx);

  app.get("/v1/status", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const { getActiveNetwork } = await import("@moneyswitch/x402");
    const network = getActiveNetwork();
    return reply.send({
      remaining_today: formatMicrosToUsdc(key.dailyBudget - usedToday(ctx.db, key.id)),
      remaining_total: formatMicrosToUsdc(key.totalBudget - usedTotal(ctx.db, key.id)),
      per_request_limit: formatMicrosToUsdc(key.perRequestLimit),
      currency: "USDC",
      network: network.caip2,
      // SPEC-v0.3-employee.md §B.0
      key_name: key.name,
      key_prefix: key.keyPrefix,
      daily_budget: formatMicrosToUsdc(key.dailyBudget),
      total_budget: formatMicrosToUsdc(key.totalBudget),
    });
  });

  app.get("/v1/history", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const { limit } = req.query as { limit?: string };
    const rows = listHistoryForKey(ctx.db, key.id, limit ? Number(limit) : 20);
    return reply.send({
      history: rows.map((p) => ({
        id: p.id,
        url: p.url,
        method: p.method,
        network: p.network,
        amount: formatMicrosToUsdc(p.amount),
        status: p.status,
        tx_hash: p.txHash,
        error_code: p.errorCode,
        created_at: p.createdAt,
        kind: p.kind,
        model: p.model,
        prompt_tokens: p.promptTokens,
        completion_tokens: p.completionTokens,
      })),
    });
  });

  app.post("/v1/fetch", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const body = req.body as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      max_price?: string;
      approval_id?: string;
    };

    function envelope(
      status: "ok" | "denied" | "approval_required" | "payment_failed" | "error",
      code: string | null,
      extra: Record<string, unknown> = {}
    ) {
      return {
        status,
        code,
        http_status: extra.http_status ?? null,
        headers: extra.headers ?? {},
        body: extra.body ?? null,
        payment: extra.payment ?? null,
        approval_id: extra.approval_id ?? null,
        remaining_today: formatMicrosToUsdc(key.dailyBudget - usedToday(ctx.db, key.id)),
        remaining_total: formatMicrosToUsdc(key.totalBudget - usedTotal(ctx.db, key.id)),
      };
    }

    let url: URL;
    try {
      url = new URL(body.url);
    } catch {
      return reply.status(400).send(envelope("error", "FORBIDDEN", {}));
    }

    try {
      checkRateLimit(ctx.db, key);
      checkHostAllowed(url, key);
      assertNotSsrf(url, { selfPort: ctx.config.port, allowedHosts: key.allowedHosts });

      if (!ctx.wallet.isUnlocked()) {
        return reply.send(envelope("error", "WALLET_LOCKED"));
      }
      const signer = ctx.wallet.getSigner()!;

      const maxPrice = body.max_price != null ? parseUsdcToMicros(body.max_price) : undefined;

      const result = await performPaidFetch(ctx.db, ctx.sqlite, key, signer, {
        url: body.url,
        host: url.hostname + ":" + (url.port || (url.protocol === "https:" ? 443 : 80)),
        method: body.method || "GET",
        headers: body.headers,
        body: body.body,
        maxPrice,
        approvalId: body.approval_id ?? null,
      });

      return reply.send(
        envelope("ok", null, {
          http_status: result.httpStatus,
          headers: result.headers,
          body: result.body,
          payment: result.payment
            ? {
                amount: result.payment.amount,
                tx_hash: result.payment.txHash,
                network: result.payment.network,
                mock: result.payment.mock ?? false,
              }
            : null,
          approval_id: result.approvalId,
        })
      );
    } catch (e) {
      if (e instanceof ApprovalRequiredError) {
        return reply.send(envelope("approval_required", "APPROVAL_REQUIRED", { approval_id: e.approvalId }));
      }
      if (e instanceof MoneySwitchError) {
        if (e.code === "PAYMENT_FAILED") {
          return reply.send(envelope("payment_failed", e.code));
        }
        if (DENIED_CODES.has(e.code)) {
          return reply.send(envelope("denied", e.code));
        }
        return reply.send(envelope("error", e.code));
      }
      req.log.error({ err: (e as Error)?.message }, "unexpected /v1/fetch error");
      return reply.send(envelope("error", "UPSTREAM_ERROR"));
    }
  });
}
