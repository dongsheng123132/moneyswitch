import { schema } from "@moneyswitch/db";
import { dbNumberToMicros } from "./money.js";
import type { MoneyKeyRow } from "./types.js";

/** Maps a raw money_keys row to the application MoneyKeyRow (money as bigint micro-USDC). */
export function rowToMoneyKey(row: typeof schema.moneyKeys.$inferSelect): MoneyKeyRow {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keyHash: row.keyHash,
    enabled: row.enabled,
    totalBudget: dbNumberToMicros(row.totalBudget),
    dailyBudget: dbNumberToMicros(row.dailyBudget),
    perRequestLimit: dbNumberToMicros(row.perRequestLimit),
    approvalThreshold: row.approvalThreshold == null ? null : dbNumberToMicros(row.approvalThreshold),
    allowedHosts: row.allowedHosts,
    maxPaymentsPerMinute: row.maxPaymentsPerMinute,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    allowedModels: row.allowedModels ?? null,
    parentId: row.parentId ?? null,
    depth: row.depth ?? 0,
    canDelegate: row.canDelegate ?? false,
    createdBy: row.createdBy ?? "admin",
  };
}
