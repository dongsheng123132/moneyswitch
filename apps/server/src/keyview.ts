import {
  formatMicrosToUsdc,
  getKeyChain,
  chainNetworkMode,
  usedToday,
  usedTotal,
  ownUsedToday,
  ownUsedTotal,
  effectiveStatus,
  type MoneyKeyRow,
  type EffectiveKeyStatus,
} from "@moneyswitch/core";
import type { MoneySwitchDb } from "@moneyswitch/db";
import { getEnabledNetworksForChain } from "@moneyswitch/x402";

/**
 * What a key's chain says about where it pays (SPEC.md §1, §6), as the API shows it: `network_mode` is the key's effective type (its own, else its
 * parent's, ...; null when no level has one, or when two levels disagree) and `networks` the CAIP-2 chains it can pay on now.
 */
export function networkFacts(chain: readonly MoneyKeyRow[]) {
  const type = chainNetworkMode(chain);
  return {
    network_mode: type.conflict ? null : type.mode,
    networks: getEnabledNetworksForChain(chain).map((n) => n.caip2),
  };
}

/**
 * Wire view of a MoneyKey (never includes key_hash or the plaintext key).
 *
 * v0.4 usage semantics: `used_today` / `used_total` are what counts against
 * THIS key's budgets, i.e. its own spend plus its whole subtree's (identical
 * to the key's own spend when it has no children). `own_used_today` /
 * `own_used_total` are the key's own payments only.
 */
export function keyView(
  db: MoneySwitchDb,
  row: MoneyKeyRow,
  extra: { childrenCount: number; status: EffectiveKeyStatus }
) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    enabled: row.enabled,
    status: extra.status,
    total_budget: formatMicrosToUsdc(row.totalBudget),
    daily_budget: formatMicrosToUsdc(row.dailyBudget),
    per_request_limit: formatMicrosToUsdc(row.perRequestLimit),
    approval_threshold: row.approvalThreshold != null ? formatMicrosToUsdc(row.approvalThreshold) : null,
    allowed_hosts: row.allowedHosts,
    max_payments_per_minute: row.maxPaymentsPerMinute,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    used_today: formatMicrosToUsdc(usedToday(db, row.id)),
    used_total: formatMicrosToUsdc(usedTotal(db, row.id)),
    own_used_today: formatMicrosToUsdc(ownUsedToday(db, row.id)),
    own_used_total: formatMicrosToUsdc(ownUsedTotal(db, row.id)),
    parent_id: row.parentId,
    depth: row.depth,
    can_delegate: row.canDelegate,
    created_by: row.createdBy,
    // v0.7.2: the effective network type ('testnet' / 'mainnet', null for a key with none anywhere in its chain) and the chains it can pay on now.
    ...networkFacts(chainOf(db, row)),
    children_count: extra.childrenCount,
  };
}

/** The key and its ancestors, read fresh; just the key itself when the chain cannot be read (the views must still render). */
function chainOf(db: MoneySwitchDb, row: MoneyKeyRow): MoneyKeyRow[] {
  try {
    return getKeyChain(db, row.id);
  } catch {
    return [row];
  }
}

/** Effective status for a key given all keys by id (walks parents in memory; for listings only). */
export function statusFromIndex(row: MoneyKeyRow, byId: Map<string, MoneyKeyRow>, nowMs = Date.now()): EffectiveKeyStatus {
  const chain: MoneyKeyRow[] = [];
  const seen = new Set<string>();
  let cur: MoneyKeyRow | undefined = row;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return effectiveStatus(chain, nowMs);
}
