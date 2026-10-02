import type { MoneySwitchDb } from "@moneyswitch/db";
import {
  backfillPaymentTxHash,
  listSettledWithoutTxHash,
  listUnknownPaymentsToReconcile,
  reconcilePaymentToFailed,
  reconcilePaymentToSettled,
} from "./payments.js";
import { writeAudit } from "./audit.js";
import type { PaymentRow } from "./types.js";

/**
 * v0.5: reads USDC's on-chain EIP-3009 state. Implemented against a real
 * chain by packages/x402 (viem); tests inject a fake implementation so this
 * never has to touch a real RPC endpoint (in particular never the running
 * testnet dev instances on :4020/:4021).
 */
export interface AuthorizationReader {
  /** USDC.authorizationState(authorizer, nonce) — true once the authorization has been consumed. */
  authorizationState(authorizer: string, nonce: string, network?: string): Promise<boolean>;
  /**
   * Best-effort lookup of the tx that consumed the authorization, via the
   * `AuthorizationUsed(authorizer indexed, nonce indexed)` event. Only called
   * once authorizationState() has already returned true. Returns null if no
   * matching log was found in the searched block range (caller falls back to
   * error_code SETTLED_TX_UNKNOWN rather than treating this as a failure).
   */
  findAuthorizationUsedTx(input: {
    network?: string;
    authorizer: string;
    nonce: string;
    /** The payment row's created_at, as epoch milliseconds — used to bound the log search window. */
    paymentCreatedAtMs: number;
    /**
     * The authorization's validBefore (unix seconds): the settle tx can only
     * have been mined between the payment's creation and this time, so
     * [paymentCreatedAtMs, validBeforeSec] bounds the block range to scan.
     */
    validBeforeSec?: number | null;
  }): Promise<string | null>;
}

export interface ReconcileUnknownPaymentsOptions {
  db: MoneySwitchDb;
  reader: AuthorizationReader;
  /** Defaults to `new Date()`. */
  now?: Date;
  /** Only reconcile authorizations whose validBefore is more than this many seconds in the past. Default 30 (SPEC). */
  graceSeconds?: number;
  /** Cap on rows processed per call. Default 200. */
  limit?: number;
  /**
   * Best-effort backfill pass: rows already settled as SETTLED_TX_UNKNOWN (no tx
   * hash) get another AuthorizationUsed lookup. Max rows tried per call; each
   * lookup can cost many RPC calls, so keep it small. Default 0 = no backfill
   * (the server's reconcile loop turns it on, throttled).
   */
  backfillTxLimit?: number;
  /** Backfill only rows created within this many days. Default 14. */
  backfillMaxAgeDays?: number;
}

export interface ReconcileUnknownPaymentsResult {
  /** Candidate rows selected (unknown, expired, not yet reconciled). */
  scanned: number;
  /** Moved to failed/NOT_SETTLED_EXPIRED (quota released). */
  failed: number;
  /** Moved to settled with a resolved tx_hash. */
  settledWithTx: number;
  /** Moved to settled but the AuthorizationUsed log could not be found (error_code SETTLED_TX_UNKNOWN). */
  settledTxUnknown: number;
  /** Reader threw (authorizationState or, less critically, findAuthorizationUsedTx) — row left untouched for the next run. */
  rpcErrors: number;
  /** id of every row touched (failed or settled), for callers that want detail. */
  reconciledPaymentIds: string[];
  /** Backfill pass: SETTLED_TX_UNKNOWN rows looked at again. */
  backfillScanned: number;
  /** Backfill pass: rows that got their tx hash. */
  backfilledTx: number;
}

/**
 * SPEC v0.5 "unknown 付款的链上对账": for every `unknown` payment whose
 * captured EIP-3009 authorization has expired (validBefore + graceSeconds in
 * the past) and hasn't been reconciled yet, ask the chain (via `reader`)
 * whether that (from, nonce) was ever actually used:
 *   - never used  -> status=failed, error_code=NOT_SETTLED_EXPIRED (ledger.ts
 *     only counts settled/reserved/unknown, so this releases the key's quota)
 *   - used        -> status=settled, tx_hash resolved from AuthorizationUsed
 *     logs when findable, else null + error_code=SETTLED_TX_UNKNOWN
 *   - reader throws -> row is left completely untouched (no reconciled_at),
 *     so the next scheduled run retries it.
 * Every row that changes status gets an audit_log entry and reconciled_at set.
 */
export async function reconcileUnknownPayments(
  opts: ReconcileUnknownPaymentsOptions
): Promise<ReconcileUnknownPaymentsResult> {
  const { db, reader } = opts;
  const now = opts.now ?? new Date();
  const graceSeconds = opts.graceSeconds ?? 30;
  const limit = opts.limit ?? 200;

  const cutoffUnixSeconds = Math.floor(now.getTime() / 1000) - graceSeconds;
  const candidates: PaymentRow[] = listUnknownPaymentsToReconcile(db, cutoffUnixSeconds, limit);

  const result: ReconcileUnknownPaymentsResult = {
    scanned: candidates.length,
    failed: 0,
    settledWithTx: 0,
    settledTxUnknown: 0,
    rpcErrors: 0,
    reconciledPaymentIds: [],
    backfillScanned: 0,
    backfilledTx: 0,
  };

  for (const payment of candidates) {
    // Guaranteed non-null by the WHERE clause in listUnknownPaymentsToReconcile.
    const authFrom = payment.authFrom!;
    const authNonce = payment.authNonce!;

    let used: boolean;
    try {
      used = await reader.authorizationState(authFrom, authNonce, payment.network);
    } catch (e) {
      result.rpcErrors++;
      continue;
    }

    const nowIso = new Date().toISOString();

    if (!used) {
      // Another (overlapping) run may have resolved this row while we were on the RPC.
      if (!reconcilePaymentToFailed(db, payment.id, nowIso)) continue;
      writeAudit(db, "system", "payment.reconcile.failed", {
        paymentId: payment.id,
        keyId: payment.keyId,
        errorCode: "NOT_SETTLED_EXPIRED",
      });
      result.failed++;
      result.reconciledPaymentIds.push(payment.id);
      continue;
    }

    // A hash the seller/facilitator already reported (settle header with
    // success:false + transaction) is kept; only look it up when we have none.
    let txHash: string | null = payment.txHash;
    if (!txHash) {
      try {
        txHash = await reader.findAuthorizationUsedTx({
          authorizer: authFrom,
          network: payment.network,
          nonce: authNonce,
          paymentCreatedAtMs: new Date(payment.createdAt).getTime(),
          validBeforeSec: payment.authValidBefore,
        });
      } catch {
        // Confirmed used on-chain but the log lookup itself failed — still
        // settle (we know it was used), just without a tx_hash; the backfill
        // pass (backfillTxLimit) tries again later.
        txHash = null;
      }
    }

    // Resolved by another (overlapping) run while we were on the RPC: leave its result alone.
    if (!reconcilePaymentToSettled(db, payment.id, txHash, nowIso)) continue;
    writeAudit(db, "system", "payment.reconcile.settled", {
      paymentId: payment.id,
      keyId: payment.keyId,
      txHash,
      errorCode: txHash ? null : "SETTLED_TX_UNKNOWN",
    });
    if (txHash) result.settledWithTx++;
    else result.settledTxUnknown++;
    result.reconciledPaymentIds.push(payment.id);
  }

  // Backfill pass (best effort, bounded): never blocks or fails the main pass.
  const backfillLimit = Math.max(0, Math.floor(opts.backfillTxLimit ?? 0));
  if (backfillLimit > 0) {
    const sinceIso = new Date(now.getTime() - (opts.backfillMaxAgeDays ?? 14) * 86_400_000).toISOString();
    let toBackfill: PaymentRow[] = [];
    try {
      // Rows the main pass settled a moment ago were just looked up (and came up empty):
      // do not repeat that expensive scan in the same run.
      const justDone = new Set(result.reconciledPaymentIds);
      toBackfill = listSettledWithoutTxHash(db, sinceIso, backfillLimit + justDone.size)
        .filter((p) => !justDone.has(p.id))
        .slice(0, backfillLimit);
    } catch {
      toBackfill = [];
    }
    for (const payment of toBackfill) {
      result.backfillScanned++;
      let txHash: string | null = null;
      try {
        txHash = await reader.findAuthorizationUsedTx({
          authorizer: payment.authFrom!,
          network: payment.network,
          nonce: payment.authNonce!,
          paymentCreatedAtMs: new Date(payment.createdAt).getTime(),
          validBeforeSec: payment.authValidBefore,
        });
      } catch {
        continue; // transient RPC trouble: the next backfill pass tries again
      }
      if (!txHash) continue;
      if (backfillPaymentTxHash(db, payment.id, txHash, new Date().toISOString())) {
        writeAudit(db, "system", "payment.reconcile.tx_backfilled", {
          paymentId: payment.id,
          keyId: payment.keyId,
          txHash,
        });
        result.backfilledTx++;
      }
    }
  }

  return result;
}
