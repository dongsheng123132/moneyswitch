import React from "react";
import type { NetworkMode } from "../api";
import { useT } from "../i18n";
import { keysStrings } from "../i18n/strings/keys";

/**
 * The first question of the key form (SPEC.md §2): testnet or mainnet. Only the kinds the instance enables are offered (one kind: just that
 * one, already chosen); a mainnet key must be confirmed, because it spends real money. The choice cannot be changed once the key is issued.
 */
export default function NetworkModeField({
  kinds,
  value,
  onChange,
  confirmed,
  onConfirmedChange,
  error,
}: {
  /** The kinds of chain the instance enables, in the order to show them. */
  kinds: readonly NetworkMode[];
  value: NetworkMode;
  onChange: (kind: NetworkMode) => void;
  /** "This key spends real money" ticked (only asked for a mainnet key). */
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  error?: string;
}) {
  const t = useT(keysStrings);
  return (
    <div className="field" role="radiogroup" aria-labelledby="key-network-mode-label" data-testid="network-mode">
      <label id="key-network-mode-label">{t("networkModeLabel")}</label>
      <div className="network-mode-options">
        {kinds.map((kind) => (
          <label key={kind} className={`network-mode-option${value === kind ? " is-active" : ""}`}>
            <input type="radio" name="network_mode" value={kind} checked={value === kind} onChange={() => onChange(kind)} />
            <span className="network-mode-title">{t(kind === "mainnet" ? "networkModeMainnet" : "networkModeTestnet")}</span>
            <span className="field-hint">{t(kind === "mainnet" ? "networkModeMainnetHint" : "networkModeTestnetHint")}</span>
          </label>
        ))}
      </div>
      <div className="field-hint">{t("networkModeFixed")}</div>
      {value === "mainnet" && (
        <label className="keys-real-money">
          <input type="checkbox" name="confirm_real_money" checked={confirmed} onChange={(e) => onConfirmedChange(e.target.checked)} />
          <span>{t("realMoneyLabel")}</span>
        </label>
      )}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
