import { and, eq } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { generateMoneyKey, sha256Hex, keyPrefix12 } from "./moneykey.js";
import { rowToMoneyKey } from "./keyrow.js";
import { MoneySwitchError } from "./types.js";
import type { MoneyKeyRow } from "./types.js";

/**
 * Issues a NEW secret for an existing MoneyKey (admin "reset secret").
 *
 * Only the sha256 of a key is stored, so a lost plaintext cannot be shown
 * again; the way out is a new secret on the same key id. Everything keyed by
 * `money_keys.id` is untouched: budgets, usage/history (payments.key_id),
 * approvals, child keys (parent_id) and every setting. Only `key_prefix` and
 * `key_hash` change, in one UPDATE, so the old secret stops authenticating
 * the moment this returns (authenticateMoneyKey looks keys up by prefix+hash).
 *
 * Returns undefined when the id does not exist. Throws KEY_REVOKED for a
 * revoked key: rotating must never bring a revoked key back to life.
 */
export function rotateMoneyKeySecret(
  db: MoneySwitchDb,
  id: string
): { plaintextKey: string; row: MoneyKeyRow; previousPrefix: string } | undefined {
  const current = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  if (!current) return undefined;
  if (!current.enabled) throw new MoneySwitchError("KEY_REVOKED", "a revoked key cannot be reset");

  const plaintextKey = generateMoneyKey();
  const updated = db
    .update(schema.moneyKeys)
    .set({ keyPrefix: keyPrefix12(plaintextKey), keyHash: sha256Hex(plaintextKey) })
    .where(and(eq(schema.moneyKeys.id, id), eq(schema.moneyKeys.enabled, true)))
    .run();
  if (updated.changes === 0) throw new MoneySwitchError("KEY_REVOKED", "a revoked key cannot be reset");

  const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  if (!row) throw new Error("failed to read back rotated key");
  return { plaintextKey, row: rowToMoneyKey(row), previousPrefix: current.keyPrefix };
}
