import type { FastifyInstance } from "fastify";
import {
  createMoneyKey,
  listMoneyKeys,
  getMoneyKeyById,
  revokeMoneyKey,
  listApprovals,
  decideApproval,
  expireStaleApprovals,
  formatMicrosToUsdc,
  childrenCounts,
  buildKeyTree,
  type KeyTreeNode,
  parseUsdcToMicros,
  listAllPayments,
  writeAudit,
} from "@moneyswitch/core";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";
import { keyView, statusFromIndex } from "../keyview.js";
import { runReconcileOnce } from "../reconcileJob.js";
import { registerWalletRoutes } from "./wallet.js";

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);

  app.post("/v1/keys", { preHandler: adminGuard }, async (req, reply) => {
    const body = req.body as {
      name: string;
      total_budget: string;
      daily_budget: string;
      per_request_limit: string;
      approval_threshold?: string | null;
      allowed_hosts: string[];
      max_payments_per_minute?: number;
      expires_at?: string | null;
      can_delegate?: boolean;
    };
    if (body?.can_delegate !== undefined && typeof body.can_delegate !== "boolean") {
      return reply.status(400).send({ error: "can_delegate must be a boolean" });
    }
    try {
      const { plaintextKey, row } = createMoneyKey(ctx.db, {
        name: body.name,
        totalBudget: parseUsdcToMicros(body.total_budget),
        dailyBudget: parseUsdcToMicros(body.daily_budget),
        perRequestLimit: parseUsdcToMicros(body.per_request_limit),
        approvalThreshold:
          body.approval_threshold != null ? parseUsdcToMicros(body.approval_threshold) : null,
        allowedHosts: body.allowed_hosts ?? [],
        maxPaymentsPerMinute: body.max_payments_per_minute,
        expiresAt: body.expires_at ?? null,
        canDelegate: body.can_delegate === true,
      });
      writeAudit(ctx.db, "admin", "key.create", { keyId: row.id, name: row.name, canDelegate: row.canDelegate });
      return reply.send({
        id: row.id,
        key: plaintextKey,
        name: row.name,
        total_budget: formatMicrosToUsdc(row.totalBudget),
        daily_budget: formatMicrosToUsdc(row.dailyBudget),
        per_request_limit: formatMicrosToUsdc(row.perRequestLimit),
        approval_threshold: row.approvalThreshold != null ? formatMicrosToUsdc(row.approvalThreshold) : null,
        allowed_hosts: row.allowedHosts,
        max_payments_per_minute: row.maxPaymentsPerMinute,
        expires_at: row.expiresAt,
        parent_id: row.parentId,
        depth: row.depth,
        can_delegate: row.canDelegate,
        created_by: row.createdBy,
      });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  /** v0.4: every key with parent_id/depth/can_delegate/children_count/status (flat, oldest first). */
  function allKeyViews() {
    const rows = listMoneyKeys(ctx.db);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const counts = childrenCounts(ctx.db);
    return rows.map((row) =>
      keyView(ctx.db, row, { childrenCount: counts.get(row.id) ?? 0, status: statusFromIndex(row, byId) })
    );
  }

  app.get("/v1/keys", { preHandler: adminGuard }, async (_req, reply) => {
    return reply.send({ keys: allKeyViews() });
  });

  // v0.4 (SPEC-v0.4 §A): the whole key forest. Each node is the same view
  // as GET /v1/keys plus `children` (oldest first).
  app.get("/v1/admin/keys/tree", { preHandler: adminGuard }, async (_req, reply) => {
    const views = new Map(allKeyViews().map((v) => [v.id, v]));
    type Node = ReturnType<typeof allKeyViews>[number] & { children: Node[] };
    const toNode = (n: KeyTreeNode): Node => ({ ...views.get(n.key.id)!, children: n.children.map(toNode) });
    return reply.send({ tree: buildKeyTree(ctx.db).map(toNode) });
  });

  app.post("/v1/keys/:id/revoke", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getMoneyKeyById(ctx.db, id);
    if (!row) return reply.status(404).send({ error: "not_found" });
    // Cascades to the whole subtree at query time (auth + policy walk the
    // ancestor chain); descendant rows are intentionally left untouched.
    revokeMoneyKey(ctx.db, id);
    writeAudit(ctx.db, "admin", "key.revoke", { keyId: id, depth: row.depth, parentId: row.parentId });
    return reply.send({ id, revoked: true });
  });

  app.get("/v1/approvals", { preHandler: adminGuard }, async (req, reply) => {
    expireStaleApprovals(ctx.db);
    const { status } = req.query as { status?: string };
    const rows = listApprovals(ctx.db, status);
    return reply.send({
      approvals: rows.map((a) => ({
        id: a.id,
        key_id: a.keyId,
        url: a.url,
        method: a.method,
        network: a.network,
        asset: a.asset,
        pay_to: a.payTo,
        amount: formatMicrosToUsdc(a.amount),
        status: a.status,
        expires_at: a.expiresAt,
        decided_at: a.decidedAt,
        created_at: a.createdAt,
      })),
    });
  });

  app.post("/v1/approvals/:id/approve", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const row = decideApproval(ctx.db, id, "approved");
      writeAudit(ctx.db, "admin", "approval.approve", { approvalId: id });
      return reply.send({ id: row.id, status: row.status });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.post("/v1/approvals/:id/deny", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const row = decideApproval(ctx.db, id, "denied");
      writeAudit(ctx.db, "admin", "approval.deny", { approvalId: id });
      return reply.send({ id: row.id, status: row.status });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.get("/v1/admin/usage", { preHandler: adminGuard }, async (_req, reply) => {
    const payments = listAllPayments(ctx.db, 200);
    return reply.send({
      payments: payments.map((p) => ({
        id: p.id,
        key_id: p.keyId,
        url: p.url,
        host: p.host,
        method: p.method,
        network: p.network,
        asset: p.asset,
        pay_to: p.payTo,
        amount: formatMicrosToUsdc(p.amount),
        status: p.status,
        tx_hash: p.txHash,
        error_code: p.errorCode,
        approval_id: p.approvalId,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
        // Old rows of the removed OpenAI-compatible gateway are kind "chat"; they still list as ordinary payments.
        kind: p.kind,
      })),
    });
  });

  // v0.5: on-chain reconciliation for `unknown` payments (SPEC-v0.5 §
  // "unknown 付款的链上对账"). Runs the exact same logic as the background
  // loop (apps/server/src/reconcileJob.ts), just on demand.
  app.post("/v1/admin/reconcile", { preHandler: adminGuard }, async (_req, reply) => {
    // On demand = also retry the tx-hash lookup for rows already settled without
    // one ("now" bypasses the loop's 15-minute backfill throttle). If a run is
    // already in flight this waits for it and reports its result.
    const result = await runReconcileOnce(ctx, { backfill: "now" });
    writeAudit(ctx.db, "admin", "payments.reconcile", {
      scanned: result.scanned,
      failed: result.failed,
      settledWithTx: result.settledWithTx,
      settledTxUnknown: result.settledTxUnknown,
      rpcErrors: result.rpcErrors,
      backfillScanned: result.backfillScanned,
      backfilledTx: result.backfilledTx,
    });
    return reply.send({
      scanned: result.scanned,
      failed: result.failed,
      settled_with_tx: result.settledWithTx,
      settled_tx_unknown: result.settledTxUnknown,
      rpc_errors: result.rpcErrors,
      reconciled_payment_ids: result.reconciledPaymentIds,
      tx_backfill_scanned: result.backfillScanned,
      tx_backfilled: result.backfilledTx,
    });
  });

  // Wallet lifecycle (create / import / backup / unlock / recovery phrase / auto-unlock / replace / health).
  registerWalletRoutes(app, ctx);
}
