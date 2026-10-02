import type { FastifyInstance } from "fastify";
import { expireStaleApprovals, getApproval, formatMicrosToUsdc } from "@moneyswitch/core";
import type { AppContext } from "../context.js";
import { requireMoneyKey } from "../auth.js";

/**
 * Agent-facing, read-only approval lookup: after /v1/fetch answers
 * `approval_required`, the agent polls this until the human has decided.
 *
 * Distinct from the admin `GET /v1/approvals` list (routes/admin.ts), which
 * needs ms_admin_xxx and sees every key's approvals. This one needs
 * mk_live_xxx and only ever returns an approval that was created for *that*
 * MoneyKey. Every other case (another key's id, unknown id) answers the same
 * 404, so a MoneyKey can never learn whether an id belongs to someone else.
 *
 * Response (the cross-package contract): {id, status, amount, currency, url, method, expires_at}.
 */
export function registerApprovalStatusRoutes(app: FastifyInstance, ctx: AppContext) {
  const keyGuard = requireMoneyKey(ctx);

  app.get("/v1/approvals/:id", { preHandler: keyGuard }, async (req, reply) => {
    const key = req.moneyKey!;
    const { id } = req.params as { id: string };

    // Same staleness sweep the admin list uses, so a poller sees `expired`
    // as soon as the 10-minute TTL has passed instead of a stale `pending`.
    expireStaleApprovals(ctx.db);

    const approval = getApproval(ctx.db, id);
    if (!approval || approval.keyId !== key.id) {
      return reply.status(404).send({ status: "error", code: "APPROVAL_NOT_FOUND" });
    }

    return reply.send({
      id: approval.id,
      status: approval.status,
      amount: formatMicrosToUsdc(approval.amount),
      currency: "USDC",
      url: approval.url,
      method: approval.method,
      expires_at: approval.expiresAt,
    });
  });
}
