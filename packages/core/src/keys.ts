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
import type { MoneyKeyRow, NetworkMode } from "./types.js";
import { MoneySwitchError } from "./types.js";
import { getKeyChain, assertChainUsable } from "./chain.js";
import { rowToMoneyKey } from "./keyrow.js";
import { hashApprovalPin, resolveApprovalPin } from "./approval-pin.js";

export { rowToMoneyKey };

export interface CreateMoneyKeyInput {
  name: string;
  totalBudget: bigint;
  dailyBudget: bigint;
  perRequestLimit: bigint;
  approvalThreshold?: bigint | null;
  allowedHosts: string[];
  maxPaymentsPerMinute?: number;
  expiresAt?: string | null;
  /** v0.4 (SPEC-v0.4 §A): may this (root) key create child keys? Default false. */
  canDelegate?: boolean;
  /** v0.7.2 (SPEC.md §1): the kind of chain this key pays on, fixed for life. Omitted = null, the pre-v0.7.2 "every enabled chain" behaviour (the server always passes one). */
  networkMode?: NetworkMode | null;
  /** v0.7.4 (SPEC.md §3): the 4-6 digit approval PIN for the person who holds the key. Omitted = a random 4-digit one; anything else that is not 4-6 digits throws ApprovalPinError. */
  approvalPin?: string | null;
}

/**
 * Creates a new ROOT MoneyKey (admin path: parent_id NULL, depth 0,
 * created_by "admin"). Child keys are created only via createChildKey
 * (delegation.ts), which enforces the parent-bound constraints.
 * Returns the plaintext key and the plaintext approval PIN (only available here; only a salted hash of the PIN is stored) plus the stored row.
 */
export function createMoneyKey(
  db: MoneySwitchDb,
  input: CreateMoneyKeyInput
): { plaintextKey: string; approvalPin: string; row: MoneyKeyRow } {
  if (
    input.approvalThreshold != null &&
    input.approvalThreshold > input.perRequestLimit
  ) {
    throw new MoneySwitchError(
      "FORBIDDEN",
      "approval_threshold must be <= per_request_limit"
    );
  }
  if (input.expiresAt != null && Number.isNaN(new Date(input.expiresAt).getTime())) {
    throw new MoneySwitchError("FORBIDDEN", "expires_at must be an ISO-8601 date-time");
  }
  const approvalPin = resolveApprovalPin(input.approvalPin);
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
      parentId: null,
      depth: 0,
      canDelegate: input.canDelegate ?? false,
      createdBy: "admin",
      networkMode: input.networkMode ?? null,
      approvalPin: hashApprovalPin(approvalPin),
    })
    .run();
  const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  if (!row) throw new Error("failed to read back created key");
  return { plaintextKey, approvalPin, row: rowToMoneyKey(row) };
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
  const key = rowToMoneyKey(match);
  // v0.4: the key itself first (same errors as before for root keys), then
  // every ancestor — revoking/expiring an ancestor disables the whole
  // subtree immediately, evaluated at query time (no batch row updates).
  assertChainUsable(getKeyChain(db, key.id));
  return key;
}
