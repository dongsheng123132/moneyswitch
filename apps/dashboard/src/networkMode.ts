// Which kinds of chain this instance enables, and which one a new key starts on (SPEC.md §1, §2, §6).
import type { AdminMeta, NetworkMode } from "./api";

/**
 * The kinds of chain the instance enables, testnet first (the order the key form offers them). Unknown (meta not loaded, or an older
 * server that does not list its networks): both, and the server has the last word when the key is created.
 */
export function enabledNetworkKinds(meta: Pick<AdminMeta, "networks"> | null | undefined): NetworkMode[] {
  if (!meta?.networks) return ["testnet", "mainnet"];
  const kinds: NetworkMode[] = [];
  if (meta.networks.some((n) => !n.is_mainnet)) kinds.push("testnet");
  if (meta.networks.some((n) => n.is_mainnet)) kinds.push("mainnet");
  return kinds.length ? kinds : ["testnet", "mainnet"];
}

/** What the form is on: the kind the admin picked if the instance enables it; else the one kind it enables, or (both enabled) the testnet. */
export function effectiveNetworkMode(kinds: readonly NetworkMode[], chosen: NetworkMode | null): NetworkMode {
  if (chosen !== null && kinds.includes(chosen)) return chosen;
  return kinds.length === 1 ? kinds[0] : "testnet";
}

/** A mainnet key spends real money, so it can only be issued once that is confirmed; a testnet key needs no confirmation. */
export function realMoneyConfirmed(mode: NetworkMode, confirmed: boolean): boolean {
  return mode !== "mainnet" || confirmed;
}
