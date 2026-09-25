import { and, desc, eq } from "drizzle-orm";
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
