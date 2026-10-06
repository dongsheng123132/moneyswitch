import type { FastifyInstance } from "fastify";
import {
  createMoneyKey,
  listMoneyKeys,
  getMoneyKeyById,
  revokeMoneyKey,
  listApprovals,
  decideApproval,
  getApproval,
  approveHostApproval,
  hostOfApproval,
  AllowHostError,
  expireStaleApprovals,
  formatMicrosToUsdc,
  childrenCounts,
  buildKeyTree,
  type KeyTreeNode,
  parseUsdcToMicros,
  listPaymentsForBills,
  writeAudit,
  setApprovalPin,
  approvalPinState,
  approvalPinStatusOfKey,
  ApprovalPinError,
  type ApprovalRow,
  type NetworkMode,
} from "@moneyswitch/core";
import { getEnabledNetworks, NETWORKS } from "@moneyswitch/x402";
import type { AppContext } from "../context.js";
import { requireAdmin, requireAdminOrApprovalPin } from "../auth.js";
import { keyView, networkFacts, statusFromIndex } from "../keyview.js";
import { runReconcileOnce } from "../reconcileJob.js";
import { registerWalletRoutes } from "./wallet.js";

/**
 * SPEC.md §1, §6: the network type a new key is issued with. Given: it must be one the instance enables. Omitted (or null): the one kind the
 * instance enables; with both kinds enabled the admin has to choose (NETWORK_MODE_REQUIRED), never a silent default.
 */
function resolveNetworkMode(requested: unknown): { mode: NetworkMode } | { code: string; message: string } {
  if (requested !== undefined && requested !== null && requested !== "testnet" && requested !== "mainnet") {
    return { code: "NETWORK_MODE_INVALID", message: 'network_mode must be "testnet" or "mainnet"' };
  }
  const enabled = new Set(getEnabledNetworks().map((n) => n.kind));
  if (requested === "testnet" || requested === "mainnet") {
    if (!enabled.has(requested)) return { code: "NETWORK_MODE_NOT_ENABLED", message: `no ${requested} network is enabled on this server (MONEYSWITCH_NETWORKS)` };
    return { mode: requested };
  }
  if (enabled.size === 1) return { mode: [...enabled][0] };
  return { code: "NETWORK_MODE_REQUIRED", message: 'both testnet and mainnet networks are enabled: say which one this key pays on ("testnet" or "mainnet")' };
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);
  const adminOrPinGuard = requireAdminOrApprovalPin(ctx);

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
      network_mode?: unknown;
      approval_pin?: unknown;
    };
    if (body?.can_delegate !== undefined && typeof body.can_delegate !== "boolean") {
      return reply.status(400).send({ error: "can_delegate must be a boolean" });
    }
    const networkMode = resolveNetworkMode(body?.network_mode);
    if ("code" in networkMode) return reply.status(400).send({ error: networkMode.code, message: networkMode.message });
    try {
      const { plaintextKey, approvalPin, row } = createMoneyKey(ctx.db, {
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
        networkMode: networkMode.mode,
        approvalPin: body.approval_pin as string | null | undefined,
      });
      writeAudit(ctx.db, "admin", "key.create", { keyId: row.id, name: row.name, canDelegate: row.canDelegate, networkMode: row.networkMode });
      return reply.send({
        id: row.id,
        key: plaintextKey,
        // the PIN of the person who holds the key (SPEC.md §3): shown once, here; only a salted hash of it is kept
        approval_pin: approvalPin,
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
        ...networkFacts([row]),
      });
    } catch (e) {
      if (e instanceof ApprovalPinError) return reply.status(400).send({ error: e.code, message: e.message });
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  /**
   * v0.4: every key with parent_id/depth/can_delegate/children_count/status (flat, oldest first). v0.7.4: `approval_pin_state` for a root key
   * ("none" = only the administrator can approve for it, "set", "locked") and `approval_pin_failures` (wrong PINs since it was last set); both
   * null for a child key, which uses its root key's PIN.
   */
  function allKeyViews() {
    const rows = listMoneyKeys(ctx.db);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const counts = childrenCounts(ctx.db);
    return rows.map((row) => ({
      ...keyView(ctx.db, row, { childrenCount: counts.get(row.id) ?? 0, status: statusFromIndex(row, byId) }),
      approval_pin_state: row.parentId == null ? approvalPinState(row) : null,
      approval_pin_failures: row.parentId == null ? row.approvalPinFailures : null,
    }));
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

  // SPEC.md §3: the person who holds a root key has a 4-6 digit PIN for its approvals. Setting one (a random 4-digit one when none is given)
  // replaces the old and unlocks; resetting the key's secret never touches it. A child key has none (400): it uses its root key's.
  app.post("/v1/keys/:id/approval-pin", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const res = setApprovalPin(ctx.db, id, (req.body as { approval_pin?: unknown } | null | undefined)?.approval_pin);
      if (!res) return reply.status(404).send({ error: "not_found" });
      writeAudit(ctx.db, "admin", "key.approval_pin_set", { keyId: id, name: res.row.name });
      return reply.header("cache-control", "no-store").send({ id, approval_pin: res.approvalPin });
    } catch (e) {
      if (e instanceof ApprovalPinError) return reply.status(400).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  /** One approval as the list and the approval link show it. */
  function approvalFields(a: ApprovalRow) {
    return {
      id: a.id,
      key_id: a.keyId,
      url: a.url,
      method: a.method,
      network: a.network,
      // 'mainnet' / 'testnet'; null for a host approval (no chain yet) or a chain the configuration table does not know
      network_kind: NETWORKS[a.network]?.kind ?? null,
      asset: a.asset,
      pay_to: a.payTo,
      amount: formatMicrosToUsdc(a.amount),
      status: a.status,
      kind: a.kind,
      // a new host's host:port as approving it lists it (core's hostPortOf, the one place it is computed): the page shows this, it parses nothing
      ...(a.kind === "host" ? { host: hostOfApproval(a) } : {}),
      expires_at: a.expiresAt,
      decided_at: a.decidedAt,
      created_at: a.createdAt,
    };
  }

  // The administrator's list; with ?id=<approval id> no login is needed and the answer is that one request (SPEC.md §3: the approval link opens
  // for the person who holds the key). The id is a random UUID the AI was given with the request: it is what lets one look at this request and
  // nothing else; deciding it still takes the key's PIN or the administrator. `pin_state` ("set" / "none" / "locked") and `pin_failures` (wrong
  // tries since it was last set) are those of its root key's PIN.
  app.get(
    "/v1/approvals",
    { preHandler: async (req, reply) => ((req.query as { id?: unknown }).id === undefined ? adminGuard(req, reply) : undefined) },
    async (req, reply) => {
      expireStaleApprovals(ctx.db);
      const { status, id } = req.query as { status?: string; id?: unknown };
      if (id !== undefined) {
        const a = typeof id === "string" ? getApproval(ctx.db, id) : undefined;
        if (!a) return reply.status(404).send({ error: "not_found" });
        const { key_id: _keyId, ...fields } = approvalFields(a);
        const pin = approvalPinStatusOfKey(ctx.db, a.keyId);
        return reply.send({
          approval: {
            ...fields,
            key_name: getMoneyKeyById(ctx.db, a.keyId)?.name ?? null,
            network_label: NETWORKS[a.network]?.label ?? null,
            pin_state: pin.state,
            pin_failures: pin.failures,
          },
        });
      }
      return reply.send({ approvals: listApprovals(ctx.db, status).map(approvalFields) });
    }
  );

  // Approve / deny: the administrator, or the person who holds the key with its PIN in the body (requireAdminOrApprovalPin); the audit row says which.
  app.post("/v1/approvals/:id/approve", { preHandler: adminOrPinGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const actor = req.approvalActor!;
    try {
      // A new host (SPEC.md §3): one DNS look, then in one transaction the approval is approved and host:port joins the key's allowed hosts.
      const row =
        getApproval(ctx.db, id)?.kind === "host"
          ? (await approveHostApproval(ctx.sqlite, ctx.db, id, actor)).approval
          : decideApproval(ctx.db, id, "approved");
      writeAudit(ctx.db, actor, "approval.approve", { approvalId: id });
      return reply.send({ id: row.id, status: row.status });
    } catch (e) {
      if (e instanceof AllowHostError) return reply.status(400).send({ error: e.code, message: e.message });
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.post("/v1/approvals/:id/deny", { preHandler: adminOrPinGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const actor = req.approvalActor!;
    try {
      const row = decideApproval(ctx.db, id, "denied");
      writeAudit(ctx.db, actor, "approval.deny", { approvalId: id });
      return reply.send({ id: row.id, status: row.status });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.get("/v1/admin/usage", { preHandler: adminGuard }, async (_req, reply) => {
    const { rows, truncated, total } = listPaymentsForBills(ctx.db);
    return reply.send({
      truncated,
      total,
      payments: rows.map((p) => ({
        id: p.id,
        key_id: p.keyId,
        url: p.url,
        host: p.host,
        method: p.method,
        network: p.network,
        // 'mainnet' / 'testnet' by the configuration table (not only the enabled chains: a row on a chain that is switched off now keeps its kind); null for a chain it does not know
        network_kind: NETWORKS[p.network]?.kind ?? null,
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
