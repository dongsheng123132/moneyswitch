import type { FastifyInstance } from "fastify";
import {
  checkRateLimit,
  checkHostAllowedForChain,
  getKeyChain,
  effectiveRemaining,
  effectivePerRequestLimit,
  effectiveApprovalThreshold,
  effectiveExpiresAt,
  DEFAULT_MAX_KEY_DEPTH,
  limitFields,
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
    const chain = getKeyChain(ctx.db, key.id);
    const self = chain[0];
    const eff = effectiveRemaining(ctx.db, chain);
    const maxDepth = ctx.config.maxKeyDepth ?? DEFAULT_MAX_KEY_DEPTH;
    const threshold = effectiveApprovalThreshold(chain);
    return reply.send({
      // v0.4: what this key can actually still spend — the minimum over the
      // key and all its ancestors (for a root key: its own remaining, as before).
      remaining_today: formatMicrosToUsdc(eff.today),
      remaining_total: formatMicrosToUsdc(eff.total),
      per_request_limit: formatMicrosToUsdc(effectivePerRequestLimit(chain)),
      currency: "USDC",
      network: network.caip2,
      // SPEC-v0.3-employee.md §B.0
      key_name: self.name,
      key_prefix: self.keyPrefix,
      daily_budget: formatMicrosToUsdc(self.dailyBudget),
      total_budget: formatMicrosToUsdc(self.totalBudget),
      // v0.4 (SPEC-v0.4 §A)
      used_today: formatMicrosToUsdc(usedToday(ctx.db, self.id)),
      used_total: formatMicrosToUsdc(usedTotal(ctx.db, self.id)),
      remaining_today_scope: eff.todayScope,
      remaining_total_scope: eff.totalScope,
      approval_threshold: threshold != null ? formatMicrosToUsdc(threshold) : null,
      expires_at: effectiveExpiresAt(chain),
      depth: self.depth,
      max_depth: maxDepth,
      can_delegate: self.canDelegate,
      can_create_children: self.canDelegate && self.depth < maxDepth,
      is_child: self.parentId != null,
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
      extra: Record<string, unknown> & {
        limit?: Record<string, string>;
        reason?: string | null;
        reserved_until_expiry?: boolean;
      } = {}
    ) {
      return {
        status,
        code,
        http_status: extra.http_status ?? null,
        headers: extra.headers ?? {},
        body: extra.body ?? null,
        payment: extra.payment ?? null,
        approval_id: extra.approval_id ?? null,
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        ...(extra.reserved_until_expiry !== undefined
          ? { reserved_until_expiry: extra.reserved_until_expiry }
          : {}),
        ...(extra.limit ?? {}),
        ...remaining(),
      };
    }

    // v0.4: effective remaining (min over the key and its ancestors).
    function remaining() {
      try {
        const eff = effectiveRemaining(ctx.db, getKeyChain(ctx.db, key.id));
        return { remaining_today: formatMicrosToUsdc(eff.today), remaining_total: formatMicrosToUsdc(eff.total) };
      } catch {
        return { remaining_today: "0", remaining_total: "0" };
      }
    }

    let url: URL;
    try {
      url = new URL(body.url);
    } catch {
      return reply.status(400).send(envelope("error", "FORBIDDEN", {}));
    }

    try {
      checkRateLimit(ctx.db, key);
      checkHostAllowedForChain(ctx.db, url, key);
      // v0.5: buying from a toll booth on this same server (/t/…) is allowed.
      assertNotSsrf(url, { selfPort: ctx.config.port, allowedHosts: key.allowedHosts, allowSelfTollbooth: true });

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

      if (result.paymentRejected) {
        // We signed and sent a payment but the seller answered 402 AGAIN (its
        // facilitator rejected our payment, e.g. insufficient_funds). The
        // reservation is kept `unknown`, not released: the signed EIP-3009
        // authorization stays valid until it expires, and the on-chain
        // reconcile loop (packages/core/src/reconcile.ts) releases the held
        // budget then if the seller never actually settles it.
        return reply.send(
          envelope("payment_failed", "PAYMENT_REJECTED", {
            http_status: result.httpStatus,
            headers: result.headers,
            body: result.body,
            reason: result.paymentRejected.reason,
            reserved_until_expiry: true,
          })
        );
      }

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
        const limit = limitFields(e);
        if (DENIED_CODES.has(e.code)) {
          return reply.send(envelope("denied", e.code, { limit }));
        }
        return reply.send(envelope("error", e.code, { limit }));
      }
      req.log.error({ err: (e as Error)?.message }, "unexpected /v1/fetch error");
      return reply.send(envelope("error", "UPSTREAM_ERROR"));
    }
  });
}
