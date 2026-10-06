import React from "react";
import type { AdminMeta } from "../api";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

/**
 * The network badge in the top bar. A single-kind instance shows its default network's name, as always. An instance that enables both
 * kinds (SPEC.md §6) shows both, "Mainnet + Testnet", with the dot in the real-money colour: one name would hide that real USDC is in play.
 */
export default function NetworkBadge({ meta }: { meta: Pick<AdminMeta, "networks" | "network_label" | "is_mainnet"> | null }) {
  const tc = useT(common);
  const networks = meta?.networks ?? [];
  const both = networks.some((n) => n.is_mainnet) && networks.some((n) => !n.is_mainnet);
  if (both) {
    return (
      <span className="network-badge" data-network-badge="mixed">
        <span className="network-dot network-dot-real" />
        {tc("networkBoth")}
      </span>
    );
  }
  return (
    <span className="network-badge" data-network-badge="single">
      <span className="network-dot" />
      {meta?.network_label ?? (meta?.is_mainnet ? tc("networkMainnet") : tc("networkTestnet"))}
    </span>
  );
}
