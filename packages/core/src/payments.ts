import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
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

export function markUnknown(db: MoneySwitchDb, id: string, errorCode?: string): void {
  db.update(schema.payments)
    .set({ status: "unknown", errorCode: errorCode ?? null, updatedAt: new Date().toISOString() })
    .where(eq(schema.payments.id, id))
    .run();
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

/** v0.5: authorization confirmed never used on-chain — release the reservation. */
export function reconcilePaymentToFailed(db: MoneySwitchDb, id: string, nowIso: string): void {
  db.update(schema.payments)
    .set({ status: "failed", errorCode: "NOT_SETTLED_EXPIRED", reconciledAt: nowIso, updatedAt: nowIso })
    .where(eq(schema.payments.id, id))
    .run();
}

/** v0.5: authorization confirmed used on-chain — belatedly record the settlement. */
export function reconcilePaymentToSettled(
  db: MoneySwitchDb,
  id: string,
  txHash: string | null,
  nowIso: string
): void {
  db.update(schema.payments)
    .set({
      status: "settled",
      txHash,
      errorCode: txHash ? null : "SETTLED_TX_UNKNOWN",
      reconciledAt: nowIso,
      updatedAt: nowIso,
    })
    .where(eq(schema.payments.id, id))
    .run();
}
