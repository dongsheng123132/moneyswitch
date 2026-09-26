import { eq } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { rowToMoneyKey } from "./keyrow.js";
import type { MoneyKeyRow, LimitScope } from "./types.js";
import { MoneySwitchError } from "./types.js";

/**
 * v0.4 (SPEC-v0.4 §A): helpers for walking a key's ancestor chain.
 *
 * A chain is `[self, parent, grandparent, ..., root]`, always read fresh from
 * the database (so when called inside the policy transaction it reflects the
 * committed state at BEGIN IMMEDIATE, not a request-start snapshot).
 */

/**
 * Hard cap on how far we walk up parent_id. Far above any configurable
 * MONEYSWITCH_MAX_KEY_DEPTH; only there so a corrupted parent graph can never
 * loop forever. Hitting it fails closed.
 */
const CHAIN_WALK_LIMIT = 64;

/** Returns [self, parent, ..., root]. Throws KEY_INVALID if `keyId` does not exist. */
export function getKeyChain(db: MoneySwitchDb, keyId: string): MoneyKeyRow[] {
  const chain: MoneyKeyRow[] = [];
  const seen = new Set<string>();
  let nextId: string | null = keyId;
  while (nextId != null) {
    if (seen.has(nextId) || chain.length >= CHAIN_WALK_LIMIT) {
      // Cycle / absurd depth: corrupted data. Fail closed.
      throw new MoneySwitchError(
        "KEY_REVOKED",
        "MoneyKey ancestor chain is corrupted",
        { scope: chain.length === 0 ? "self" : "ancestor", keyPrefix: chain[chain.length - 1]?.keyPrefix ?? "" }
      );
    }
    seen.add(nextId);
    const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, nextId)).get();
    if (!row) {
      if (chain.length === 0) {
        throw new MoneySwitchError("KEY_INVALID", "MoneyKey no longer exists");
      }
      // A referenced ancestor is gone (should be impossible: FK + no delete
      // API). Treat it as revoked so the subtree fails closed.
      throw new MoneySwitchError("KEY_REVOKED", "MoneyKey ancestor no longer exists", {
        scope: "ancestor",
        keyPrefix: chain[chain.length - 1].keyPrefix,
      });
    }
    const key = rowToMoneyKey(row);
    chain.push(key);
    nextId = key.parentId;
  }
  return chain;
}

export function scopeAt(index: number): LimitScope {
  return index === 0 ? "self" : "ancestor";
}

export function isKeyExpired(key: Pick<MoneyKeyRow, "expiresAt">, nowMs: number = Date.now()): boolean {
  return key.expiresAt != null && new Date(key.expiresAt).getTime() < nowMs;
}

/**
 * Throws KEY_REVOKED / KEY_EXPIRED (with limit scope + prefix) unless the key
 * and every ancestor are enabled and unexpired. Checks the key itself first,
 * so a root key reports exactly what it did before v0.4.
 */
export function assertChainUsable(chain: MoneyKeyRow[], nowMs: number = Date.now()): void {
  chain.forEach((k, i) => {
    const limit = { scope: scopeAt(i), keyPrefix: k.keyPrefix };
    if (!k.enabled) {
      throw new MoneySwitchError(
        "KEY_REVOKED",
        i === 0 ? "MoneyKey has been revoked" : "An ancestor of this MoneyKey has been revoked",
        limit
      );
    }
    if (isKeyExpired(k, nowMs)) {
      throw new MoneySwitchError(
        "KEY_EXPIRED",
        i === 0 ? "MoneyKey has expired" : "An ancestor of this MoneyKey has expired",
        limit
      );
    }
  });
}

/** Status of a key taking its ancestors into account (for listings; never used for authorization). */
export type EffectiveKeyStatus = "active" | "revoked" | "expired" | "ancestor_revoked" | "ancestor_expired";

export function effectiveStatus(chain: MoneyKeyRow[], nowMs: number = Date.now()): EffectiveKeyStatus {
  try {
    assertChainUsable(chain, nowMs);
    return "active";
  } catch (e) {
    const err = e as MoneySwitchError;
    const ancestor = err.limit?.scope === "ancestor";
    if (err.code === "KEY_EXPIRED") return ancestor ? "ancestor_expired" : "expired";
    return ancestor ? "ancestor_revoked" : "revoked";
  }
}

/**
 * Model allow-list in effect for a key: the intersection over the chain
 * (null on a level = no restriction at that level). Child keys are already
 * created as subsets of their parent, so this normally equals the key's own
 * list; intersecting at use time is defense in depth.
 */
export function effectiveAllowedModels(chain: MoneyKeyRow[]): string[] | null {
  let allowed: string[] | null = null;
  for (const k of chain) {
    if (k.allowedModels == null) continue;
    allowed = allowed == null ? [...k.allowedModels] : allowed.filter((m) => k.allowedModels!.includes(m));
  }
  return allowed;
}
