import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { dbNumberToMicros } from "./money.js";

const COUNTED_STATUSES = ["settled", "reserved", "unknown"] as const;

/** Start of the current UTC day, as an ISO string. */
export function startOfUtcDay(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
}

/** Sum of settled+reserved+unknown payments for a key since a given ISO timestamp (or all-time if omitted). */
export function sumUsed(db: MoneySwitchDb, keyId: string, sinceIso?: string): bigint {
  const conditions = [
    eq(schema.payments.keyId, keyId),
    inArray(schema.payments.status, [...COUNTED_STATUSES]),
  ];
  if (sinceIso) {
    conditions.push(gte(schema.payments.createdAt, sinceIso));
  }
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${schema.payments.amount}), 0)` })
    .from(schema.payments)
    .where(and(...conditions))
    .get();
  return dbNumberToMicros(row?.total ?? 0);
}

export function usedToday(db: MoneySwitchDb, keyId: string, now: Date = new Date()): bigint {
  return sumUsed(db, keyId, startOfUtcDay(now));
}

export function usedTotal(db: MoneySwitchDb, keyId: string): bigint {
  return sumUsed(db, keyId);
}

/** Number of payments (any status) created by this key in the last 60 seconds — used for RATE_LIMITED. */
export function paymentsInLastMinute(db: MoneySwitchDb, keyId: string, now: Date = new Date()): number {
  const sinceIso = new Date(now.getTime() - 60_000).toISOString();
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.payments)
    .where(and(eq(schema.payments.keyId, keyId), gte(schema.payments.createdAt, sinceIso)))
    .get();
  return row?.count ?? 0;
}
