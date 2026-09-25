import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { dbNumberToMicros, microsToDbNumber } from "./money.js";
import {
  generateMoneyKey,
  sha256Hex,
  keyPrefix12,
  verifySecretAgainstHash,
} from "./moneykey.js";
import type { MoneyKeyRow } from "./types.js";
import { MoneySwitchError } from "./types.js";

function rowToMoneyKey(row: typeof schema.moneyKeys.$inferSelect): MoneyKeyRow {
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
  };
}

export interface CreateMoneyKeyInput {
  name: string;
  totalBudget: bigint;
  dailyBudget: bigint;
  perRequestLimit: bigint;
  approvalThreshold?: bigint | null;
  allowedHosts: string[];
  maxPaymentsPerMinute?: number;
  expiresAt?: string | null;
  /** v0.2 (SPEC-v0.2 §1): null/omitted = allowed to use all enabled channels' models. */
  allowedModels?: string[] | null;
}

/** Creates a new MoneyKey. Returns the plaintext key (only available here) plus the stored row. */
export function createMoneyKey(
  db: MoneySwitchDb,
  input: CreateMoneyKeyInput
): { plaintextKey: string; row: MoneyKeyRow } {
  if (
    input.approvalThreshold != null &&
    input.approvalThreshold > input.perRequestLimit
  ) {
    throw new MoneySwitchError(
      "FORBIDDEN",
      "approval_threshold must be <= per_request_limit"
    );
  }
  const plaintextKey = generateMoneyKey();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(schema.moneyKeys)
    .values({
      id,
      name: input.name,
      keyPrefix: keyPrefix12(plaintextKey),
      keyHash: sha256Hex(plaintextKey),
      enabled: true,
      totalBudget: microsToDbNumber(input.totalBudget),
      dailyBudget: microsToDbNumber(input.dailyBudget),
      perRequestLimit: microsToDbNumber(input.perRequestLimit),
      approvalThreshold:
        input.approvalThreshold == null ? null : microsToDbNumber(input.approvalThreshold),
      allowedHosts: input.allowedHosts,
      maxPaymentsPerMinute: input.maxPaymentsPerMinute ?? 10,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      lastUsedAt: null,
      allowedModels: input.allowedModels ?? null,
    })
    .run();
  const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  if (!row) throw new Error("failed to read back created key");
  return { plaintextKey, row: rowToMoneyKey(row) };
}

export function listMoneyKeys(db: MoneySwitchDb): MoneyKeyRow[] {
  return db.select().from(schema.moneyKeys).all().map(rowToMoneyKey);
}

export function getMoneyKeyById(db: MoneySwitchDb, id: string): MoneyKeyRow | undefined {
  const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  return row ? rowToMoneyKey(row) : undefined;
}

export function revokeMoneyKey(db: MoneySwitchDb, id: string): void {
  db.update(schema.moneyKeys).set({ enabled: false }).where(eq(schema.moneyKeys.id, id)).run();
}

export function touchLastUsed(db: MoneySwitchDb, id: string): void {
  db.update(schema.moneyKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(schema.moneyKeys.id, id))
    .run();
}

/**
 * Authenticates a MoneyKey by prefix lookup + constant-time hash comparison.
 * Returns the row on success, or throws MoneySwitchError with the exact
 * failure reason (KEY_INVALID / KEY_REVOKED / KEY_EXPIRED).
 */
export function authenticateMoneyKey(db: MoneySwitchDb, plaintextKey: string): MoneyKeyRow {
  const prefix = keyPrefix12(plaintextKey);
  const candidates = db
    .select()
    .from(schema.moneyKeys)
    .where(eq(schema.moneyKeys.keyPrefix, prefix))
    .all();
  const match = candidates.find((c) => verifySecretAgainstHash(plaintextKey, c.keyHash));
  if (!match) {
    throw new MoneySwitchError("KEY_INVALID", "MoneyKey not found or invalid");
  }
  if (!match.enabled) {
    throw new MoneySwitchError("KEY_REVOKED", "MoneyKey has been revoked");
  }
  if (match.expiresAt && new Date(match.expiresAt).getTime() < Date.now()) {
    throw new MoneySwitchError("KEY_EXPIRED", "MoneyKey has expired");
  }
  return rowToMoneyKey(match);
}
