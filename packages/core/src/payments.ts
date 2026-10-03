import { and, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { writeAudit } from "./audit.js";
import { dbNumberToMicros } from "./money.js";
import type { PaymentRow, PaymentStatus } from "./types.js";

function rowToPayment(row: typeof schema.payments.$inferSelect): PaymentRow {
  return {
    id: row.id,
    keyId: row.keyId,
    url: row.url,
    host: row.host,
    method: row.method,
    network: row.network,
    asset: row.asset,
    payTo: row.payTo,
    amount: dbNumberToMicros(row.amount),
    status: row.status,
    txHash: row.txHash,
    errorCode: row.errorCode,
    approvalId: row.approvalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    kind: row.kind,
    model: row.model,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    authFrom: row.authFrom,
    authNonce: row.authNonce,
    authValidBefore: row.authValidBefore,
    reconciledAt: row.reconciledAt,
  };
}

export function getPayment(db: MoneySwitchDb, id: string): PaymentRow | undefined {
  const row = db.select().from(schema.payments).where(eq(schema.payments.id, id)).get();
  return row ? rowToPayment(row) : undefined;
}

export function settlePayment(db: MoneySwitchDb, id: string, txHash: string): void {
  db.update(schema.payments)
    .set({ status: "settled", txHash, updatedAt: new Date().toISOString() })
    .where(eq(schema.payments.id, id))
    .run();
}

export function failPayment(db: MoneySwitchDb, id: string, errorCode: string): void {
  db.update(schema.payments)
    .set({ status: "failed", errorCode, updatedAt: new Date().toISOString() })
    .where(eq(schema.payments.id, id))
    .run();
}

/**
 * Keeps the reservation (`unknown` still counts against the key's limits) until
 * reconcile resolves it on-chain. `opts.txHash` records a transaction hash the
 * seller/facilitator REPORTED for a settlement it could not confirm (e.g. the
 * x402 facilitator's `settlement_pending`); it is a lead, not proof, and reconcile
 * still decides settled vs failed from the chain. Omitted/empty leaves tx_hash as is.
 */
export function markUnknown(
  db: MoneySwitchDb,
  id: string,
  errorCode?: string,
  opts?: { txHash?: string | null }
): void {
  db.update(schema.payments)
    .set({
      status: "unknown",
      errorCode: errorCode ?? null,
      updatedAt: new Date().toISOString(),
      ...(opts?.txHash ? { txHash: opts.txHash } : {}),
    })
    .where(eq(schema.payments.id, id))
    .run();
}

export interface SweepStaleReservationsResult {
  /** Reserved rows with a captured authorization: now `unknown` (still counted; reconcile resolves them on chain). */
  toUnknown: string[];
  /** Reserved rows nothing was ever signed for: now `failed` (budget released). */
  toFailed: string[];
}

/**
 * Startup sweep of payments a dead process left `reserved`. Run once, synchronously, BEFORE the server accepts
 * requests: every `reserved` row created before `bootedAtIso` belongs to a process that no longer exists, so
 * nothing will ever settle, fail or mark it, and `reserved` counts against the key's budget forever.
 *
 *  - an EIP-3009 authorization was captured (`auth_*`, written by the x402 hook right after the buyer signed and
 *    before the paid request left) means the money MAY have moved: the row becomes `unknown`, which keeps it counted
 *    and lets reconcile ask the chain once the authorization has expired;
 *  - without one nothing was ever signed, so nothing can have moved: the row becomes `failed` and the budget is
 *    released.
 *
 * Rows created at or after `bootedAtIso` belong to this process and are not touched.
 */
export function sweepStaleReservations(db: MoneySwitchDb, bootedAtIso: string): SweepStaleReservationsResult {
  const stale = db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.status, "reserved"), lt(schema.payments.createdAt, bootedAtIso)))
    .orderBy(schema.payments.createdAt)
    .all()
    .map(rowToPayment);

  const result: SweepStaleReservationsResult = { toUnknown: [], toFailed: [] };
  for (const payment of stale) {
    // Any trace of a signed authorization counts: a half-written triple is still evidence that something was signed.
    const signed = payment.authFrom !== null || payment.authNonce !== null || payment.authValidBefore !== null;
    if (signed) {
      markUnknown(db, payment.id, "RESTARTED_IN_FLIGHT");
      writeAudit(db, "system", "payment.startup_sweep.unknown", { paymentId: payment.id, keyId: payment.keyId, errorCode: "RESTARTED_IN_FLIGHT" });
      result.toUnknown.push(payment.id);
    } else {
      failPayment(db, payment.id, "RESTARTED_BEFORE_SIGNING");
      writeAudit(db, "system", "payment.startup_sweep.failed", { paymentId: payment.id, keyId: payment.keyId, errorCode: "RESTARTED_BEFORE_SIGNING" });
      result.toFailed.push(payment.id);
    }
  }
  return result;
}

/**
 * v0.5: called from the x402 client's onAfterPaymentCreation hook, right
 * after the exact-EIP-3009 scheme signs the buyer's transferWithAuthorization
 * — before the paid request is even sent. Lets reconcileUnknownPayments later
 * ask the USDC contract on-chain whether this specific (from, nonce) was ever
 * used, independent of whether we ever got a settle response back.
 */
export function recordPaymentAuthorization(
  db: MoneySwitchDb,
  id: string,
  auth: { from: string; nonce: string; validBefore: number }
): void {
  db.update(schema.payments)
    .set({
      authFrom: auth.from,
      authNonce: auth.nonce,
      authValidBefore: auth.validBefore,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.payments.id, id))
    .run();
}

/**
 * v0.2 (SPEC-v0.2 §2 step 7): fills in prompt/completion token counts on an
 * already-reserved/settled payment row, once the upstream chat completion's
 * `usage` object is known. Does not touch status/tx_hash — call after
 * performPaidFetch's own settle/fail/unknown reconciliation.
 */
export function recordPaymentUsage(
  db: MoneySwitchDb,
  id: string,
  usage: { promptTokens?: number | null; completionTokens?: number | null }
): void {
  db.update(schema.payments)
    .set({
      promptTokens: usage.promptTokens ?? null,
      completionTokens: usage.completionTokens ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.payments.id, id))
    .run();
}

export function listHistoryForKey(db: MoneySwitchDb, keyId: string, limit = 20): PaymentRow[] {
  return db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.keyId, keyId))
    .orderBy(desc(schema.payments.createdAt))
    .limit(limit)
    .all()
    .map(rowToPayment);
}

export function listAllPayments(db: MoneySwitchDb, limit = 100): PaymentRow[] {
  return db
    .select()
    .from(schema.payments)
    .orderBy(desc(schema.payments.createdAt))
    .limit(limit)
    .all()
    .map(rowToPayment);
}

/**
 * v0.5: `unknown` payments whose EIP-3009 authorization has expired (past
 * `validBefore` + a grace period) and were never reconciled — candidates for
 * reconcileUnknownPayments. Rows without a captured authorization (e.g. an
 * older payment from before this migration, or a non-EIP-3009 scheme) are
 * never selected: there is nothing on-chain to check them against.
 */
export function listUnknownPaymentsToReconcile(
  db: MoneySwitchDb,
  cutoffUnixSeconds: number,
  limit = 200
): PaymentRow[] {
  return db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.status, "unknown"),
        isNull(schema.payments.reconciledAt),
        isNotNull(schema.payments.authFrom),
        isNotNull(schema.payments.authNonce),
        isNotNull(schema.payments.authValidBefore),
        lt(schema.payments.authValidBefore, cutoffUnixSeconds)
      )
    )
    .orderBy(schema.payments.createdAt)
    .limit(limit)
    .all()
    .map(rowToPayment);
}

/** Only a row that is still `unknown` and not yet reconciled may be resolved: a slower, overlapping run must never overwrite a finished one. */
function stillUnreconciled(id: string) {
  return and(
    eq(schema.payments.id, id),
    eq(schema.payments.status, "unknown"),
    isNull(schema.payments.reconciledAt)
  );
}

/**
 * v0.5: authorization confirmed never used on-chain — release the reservation.
 * Returns false (and changes nothing) when the row is no longer `unknown`/unreconciled,
 * i.e. another run already resolved it.
 */
export function reconcilePaymentToFailed(db: MoneySwitchDb, id: string, nowIso: string): boolean {
  const r = db
    .update(schema.payments)
    .set({ status: "failed", errorCode: "NOT_SETTLED_EXPIRED", reconciledAt: nowIso, updatedAt: nowIso })
    .where(stillUnreconciled(id))
    .run();
  return r.changes > 0;
}

/**
 * v0.5: authorization confirmed used on-chain — belatedly record the settlement.
 * Returns false (and changes nothing) when the row is no longer `unknown`/unreconciled,
 * so an overlapping run can never replace a found tx hash with null.
 */
export function reconcilePaymentToSettled(
  db: MoneySwitchDb,
  id: string,
  txHash: string | null,
  nowIso: string
): boolean {
  const r = db
    .update(schema.payments)
    .set({
      status: "settled",
      txHash,
      errorCode: txHash ? null : "SETTLED_TX_UNKNOWN",
      reconciledAt: nowIso,
      updatedAt: nowIso,
    })
    .where(stillUnreconciled(id))
    .run();
  return r.changes > 0;
}

/**
 * Rows reconcile already settled WITHOUT a tx hash (SETTLED_TX_UNKNOWN: the
 * AuthorizationUsed lookup found nothing, hit an RPC error or its call cap, or
 * ran before the lookup existed). Candidates for a later, best-effort backfill.
 * Only rows created at or after `sinceIso` (a bounded look-back), newest first.
 */
export function listSettledWithoutTxHash(db: MoneySwitchDb, sinceIso: string, limit = 3): PaymentRow[] {
  return db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.status, "settled"),
        eq(schema.payments.errorCode, "SETTLED_TX_UNKNOWN"),
        isNull(schema.payments.txHash),
        isNotNull(schema.payments.authFrom),
        isNotNull(schema.payments.authNonce),
        gte(schema.payments.createdAt, sinceIso)
      )
    )
    .orderBy(desc(schema.payments.createdAt))
    .limit(limit)
    .all()
    .map(rowToPayment);
}

/** Stores a tx hash found later for a settled row that has none; clears SETTLED_TX_UNKNOWN. False if the row was already filled/changed. */
export function backfillPaymentTxHash(db: MoneySwitchDb, id: string, txHash: string, nowIso: string): boolean {
  const r = db
    .update(schema.payments)
    .set({ txHash, errorCode: null, updatedAt: nowIso })
    .where(
      and(
        eq(schema.payments.id, id),
        eq(schema.payments.status, "settled"),
        eq(schema.payments.errorCode, "SETTLED_TX_UNKNOWN"),
        isNull(schema.payments.txHash)
      )
    )
    .run();
  return r.changes > 0;
}
