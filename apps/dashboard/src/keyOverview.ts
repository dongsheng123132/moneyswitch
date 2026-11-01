import type { MoneyKeyRow, NetworkMode } from "./api";

export type KeyStateFilter = "active" | "inactive" | "all";

/** Counts keys, not their subtree spending: a parent and its descendants must not double-count money. */
export function keyOverview(keys: readonly MoneyKeyRow[]) {
  const active = keys.filter((key) => key.status === "active");
  return {
    total: keys.length,
    active: active.length,
    inactive: keys.length - active.length,
    legacy: active.filter((key) => key.network_mode == null).length,
    mainnet: active.filter((key) => key.network_mode === "mainnet").length,
    testnet: active.filter((key) => key.network_mode === "testnet").length,
  };
}

export function visibleKeys(keys: readonly MoneyKeyRow[], search: string, state: KeyStateFilter, network: NetworkMode | "all") {
  const term = search.trim().toLocaleLowerCase();
  return keys.filter((key) =>
    (state === "all" || (state === "active" ? key.status === "active" : key.status !== "active")) &&
    (network === "all" || key.network_mode === network) &&
    (!term || key.name.toLocaleLowerCase().includes(term) || key.key_prefix.toLocaleLowerCase().includes(term))
  ).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}
