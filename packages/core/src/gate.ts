import { MoneySwitchError } from "./types.js";
import type { MoneyKeyRow } from "./types.js";
import { paymentsInLastMinuteSubtree } from "./ledger.js";
import { getKeyChain, scopeAt } from "./chain.js";
import { isHostListed } from "./host-approval.js";
import type { MoneySwitchDb } from "@moneyswitch/db";

/**
 * SPEC §6 step 1: rate limit check (max_payments_per_minute).
 *
 * v0.4: checked for the key and every ancestor, each against the payment
 * count of its whole subtree — so splitting a key into children cannot be
 * used to multiply its per-minute allowance.
 */
export function checkRateLimit(db: MoneySwitchDb, key: MoneyKeyRow, now = new Date()): void {
  const chain = getKeyChain(db, key.id);
  chain.forEach((k, i) => {
    const count = paymentsInLastMinuteSubtree(db, k.id, now);
    if (count >= k.maxPaymentsPerMinute) {
      throw new MoneySwitchError("RATE_LIMITED", undefined, { scope: scopeAt(i), keyPrefix: k.keyPrefix });
    }
  });
}

/**
 * SPEC §6 step 1 + §2.6: URL must be http(s) and host:port must be in
 * allowed_hosts. Applies to ALL /v1/fetch requests including free ones.
 * An empty allowed_hosts list means "reject everything".
 */
export function checkHostAllowed(url: URL, key: MoneyKeyRow): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MoneySwitchError("HOST_NOT_ALLOWED", "URL must be http or https");
  }
  // host-approval.ts: the URL and each entry are spelled alike (lower case, one trailing dot dropped), so "example.com." is "example.com"
  if (!isHostListed(url, key.allowedHosts)) {
    throw new MoneySwitchError("HOST_NOT_ALLOWED");
  }
}

/**
 * v0.4: checkHostAllowed for the key and every ancestor. A child's
 * allowed_hosts is created as a subset of its parent's, so this normally
 * adds nothing — it is defense in depth against a child ever holding a
 * host its ancestors do not allow.
 */
export function checkHostAllowedForChain(db: MoneySwitchDb, url: URL, key: MoneyKeyRow): void {
  const chain = getKeyChain(db, key.id);
  chain.forEach((k, i) => {
    try {
      checkHostAllowed(url, k);
    } catch (e) {
      const err = e as MoneySwitchError;
      throw new MoneySwitchError(err.code, undefined, { scope: scopeAt(i), keyPrefix: k.keyPrefix });
    }
  });
}
