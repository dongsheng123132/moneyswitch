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

/**
 * v0.4 (SPEC-v0.4 §A): sum of settled+reserved+unknown payments made by a key
 * AND every key in its subtree (children, grandchildren, ...), since a given
 * ISO timestamp (or all-time). This is what counts against a key's own
 * daily/total budget: a parent's budget caps its whole subtree. For a key
 * without children it equals `sumUsed`.
 *
 * `UNION` (not `UNION ALL`) in the recursive CTE makes the walk terminate
 * even if the parent_id graph were ever corrupted into a cycle.
 */
export function sumUsedSubtree(db: MoneySwitchDb, keyId: string, sinceIso?: string): bigint {
  const since = sinceIso
    ? sql` AND ${schema.payments.createdAt} >= ${sinceIso}`
    : sql``;
  const row = db.get<{ total: number | null }>(sql`
    WITH RECURSIVE subtree(id) AS (
      SELECT ${keyId}
      UNION
      SELECT k.id FROM money_keys k JOIN subtree s ON k.parent_id = s.id
    )
    SELECT COALESCE(SUM(${schema.payments.amount}), 0) AS total
    FROM ${schema.payments}
    WHERE ${schema.payments.keyId} IN (SELECT id FROM subtree)
      AND ${schema.payments.status} IN ('settled', 'reserved', 'unknown')${since}
  `);
  return dbNumberToMicros(row?.total ?? 0);
}

/**
 * Used today (UTC) against this key's daily budget — i.e. including its whole
 * subtree (v0.4). Identical to the key's own spend when it has no children.
 */
export function usedToday(db: MoneySwitchDb, keyId: string, now: Date = new Date()): bigint {
  return sumUsedSubtree(db, keyId, startOfUtcDay(now));
}

/** All-time used against this key's total budget, including its whole subtree (v0.4). */
export function usedTotal(db: MoneySwitchDb, keyId: string): bigint {
  return sumUsedSubtree(db, keyId);
}

/** v0.4: today's spend by this key alone (excluding its children). */
export function ownUsedToday(db: MoneySwitchDb, keyId: string, now: Date = new Date()): bigint {
  return sumUsed(db, keyId, startOfUtcDay(now));
}

/** v0.4: all-time spend by this key alone (excluding its children). */
export function ownUsedTotal(db: MoneySwitchDb, keyId: string): bigint {
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

/**
 * v0.4: number of payments (any status) created in the last 60 seconds by
 * this key or any key in its subtree — a parent's max_payments_per_minute
 * caps its whole subtree, like its budgets.
 */
export function paymentsInLastMinuteSubtree(db: MoneySwitchDb, keyId: string, now: Date = new Date()): number {
  const sinceIso = new Date(now.getTime() - 60_000).toISOString();
  const row = db.get<{ count: number }>(sql`
    WITH RECURSIVE subtree(id) AS (
      SELECT ${keyId}
      UNION
      SELECT k.id FROM money_keys k JOIN subtree s ON k.parent_id = s.id
    )
    SELECT COUNT(*) AS count
    FROM ${schema.payments}
    WHERE ${schema.payments.keyId} IN (SELECT id FROM subtree)
      AND ${schema.payments.createdAt} >= ${sinceIso}
  `);
  return row?.count ?? 0;
}
