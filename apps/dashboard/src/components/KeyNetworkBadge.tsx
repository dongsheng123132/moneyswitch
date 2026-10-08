import React from "react";
import type { NetworkMode } from "../api";
import { useT } from "../i18n";
import { keysStrings } from "../i18n/strings/keys";
import NetworkKindPill from "./NetworkKindPill";
import Pill from "./Pill";

/**
 * The mark on a key in the list (SPEC.md §2): "Testnet" or "Mainnet". A key with no network type (issued before v0.7.2) is "Legacy key", with the
 * chains it really pays on (the API says: the testnets only where the server enables both kinds), and while it is still active the list
 * suggests revoking it and issuing a new one.
 */
export default function KeyNetworkBadge({ mode, active, chains, compact = false }: { mode: NetworkMode | null | undefined; active: boolean; chains?: readonly string[]; compact?: boolean }) {
  const t = useT(keysStrings);
  if (mode === "testnet" || mode === "mainnet") return <NetworkKindPill kind={mode} />;
  if (compact) return (
    <details className="key-legacy-details">
      <summary><Pill tone="gray">{t("networkLegacy")}</Pill></summary>
      <div className="field-hint key-legacy-chains">{chains?.length ? t("networkLegacyChains", { chains: chains.join(", ") }) : t("networkLegacyNoChains")}</div>
      {active && <div className="field-hint key-legacy-hint">{t("networkLegacyHint")}</div>}
    </details>
  );
  return (
    <>
      <span data-network-kind="legacy" title={t("networkLegacyHint")}>
        <Pill tone="gray">{t("networkLegacy")}</Pill>
      </span>
      <div className="field-hint key-legacy-chains" data-testid="legacy-chains">
        {chains && chains.length > 0 ? t("networkLegacyChains", { chains: chains.join(", ") }) : t("networkLegacyNoChains")}
      </div>
      {active && <div className="field-hint key-legacy-hint">{t("networkLegacyHint")}</div>}
    </>
  );
}
