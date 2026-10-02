import { reconcileUnknownPayments, type ReconcileUnknownPaymentsResult } from "@moneyswitch/core";
import type { AppContext } from "./context.js";

const EMPTY_RESULT: ReconcileUnknownPaymentsResult = {
  scanned: 0,
  failed: 0,
  settledWithTx: 0,
  settledTxUnknown: 0,
  rpcErrors: 0,
  reconciledPaymentIds: [],
  backfillScanned: 0,
  backfilledTx: 0,
};

/**
 * Rows already settled WITHOUT a tx hash (SETTLED_TX_UNKNOWN) get another
 * AuthorizationUsed lookup, but only this often: one lookup can cost dozens of
 * RPC calls on a rate-limited public node, so it must not run every 60 s tick.
 * The first run after boot always does it (the rows reconciled by a build that
 * had no log lookup get their hash within a minute of the upgrade).
 */
export const BACKFILL_EVERY_MS = 15 * 60_000;
/** Rows tried per backfill pass. */
export const BACKFILL_ROWS_PER_PASS = 3;

// One reconcile run at a time per context. A run can now take minutes on a slow
// RPC (chunked eth_getLogs), longer than the 60 s tick; overlapping runs would
// re-process the same rows and multiply the load on the node.
const inFlight = new WeakMap<AppContext, Promise<ReconcileUnknownPaymentsResult>>();
const lastBackfillAt = new WeakMap<AppContext, number>();

export interface RunReconcileOptions {
  /**
   * "auto" (default, the background loop): backfill at most every BACKFILL_EVERY_MS.
   * "now" (POST /v1/admin/reconcile): backfill in this run regardless.
   */
  backfill?: "auto" | "now";
}

/**
 * v0.5: runs reconcileUnknownPayments once against this context's DB and
 * chain reader. Shared by the background interval loop and
 * POST /v1/admin/reconcile so both go through the exact same logic. A no-op
 * (rather than throwing) when no chainReader is configured, so booting
 * without one (e.g. a hand-built AppContext in a test that never calls
 * reconcile) never crashes anything.
 *
 * If a run for this context is already in flight, its promise is returned
 * instead of starting a second one (the loop tick is skipped; an admin request
 * simply waits for and reports that run).
 */
export function runReconcileOnce(
  ctx: AppContext,
  opts: RunReconcileOptions = {}
): Promise<ReconcileUnknownPaymentsResult> {
  if (!ctx.chainReader) return Promise.resolve(EMPTY_RESULT);
  const running = inFlight.get(ctx);
  if (running) return running;

  const now = Date.now();
  const backfill = opts.backfill === "now" || now - (lastBackfillAt.get(ctx) ?? 0) >= BACKFILL_EVERY_MS;
  if (backfill) lastBackfillAt.set(ctx, now);

  const run = reconcileUnknownPayments({
    db: ctx.db,
    reader: ctx.chainReader,
    backfillTxLimit: backfill ? BACKFILL_ROWS_PER_PASS : 0,
  }).finally(() => {
    inFlight.delete(ctx);
  });
  inFlight.set(ctx, run);
  return run;
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
