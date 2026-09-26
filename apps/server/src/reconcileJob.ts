import { reconcileUnknownPayments, type ReconcileUnknownPaymentsResult } from "@moneyswitch/core";
import type { AppContext } from "./context.js";

const EMPTY_RESULT: ReconcileUnknownPaymentsResult = {
  scanned: 0,
  failed: 0,
  settledWithTx: 0,
  settledTxUnknown: 0,
  rpcErrors: 0,
  reconciledPaymentIds: [],
};

/**
 * v0.5: runs reconcileUnknownPayments once against this context's DB and
 * chain reader. Shared by the background interval loop and
 * POST /v1/admin/reconcile so both go through the exact same logic. A no-op
 * (rather than throwing) when no chainReader is configured, so booting
 * without one (e.g. a hand-built AppContext in a test that never calls
 * reconcile) never crashes anything.
 */
export async function runReconcileOnce(ctx: AppContext): Promise<ReconcileUnknownPaymentsResult> {
  if (!ctx.chainReader) return EMPTY_RESULT;
  return reconcileUnknownPayments({ db: ctx.db, reader: ctx.chainReader });
}

/**
 * v0.5: starts the background reconciliation loop (SPEC: every 60s by
 * default, configurable via MONEYSWITCH_RECONCILE_INTERVAL_MS, 0 disables
 * it). The returned timer is unref'd so it never keeps the process alive on
 * its own (matches every other backgroundish timer in this codebase).
 */
export function startReconcileLoop(ctx: AppContext, intervalMs: number): { stop: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { stop: () => {} };
  }
  const timer = setInterval(() => {
    runReconcileOnce(ctx).catch((e) => {
      console.error("[moneyswitch] reconcile loop error:", e instanceof Error ? e.message : e);
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
