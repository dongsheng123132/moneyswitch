import React, { useState } from "react";
import { unlockWallet, type WalletInfo } from "../api";
import { useT } from "../i18n";
import { walletLifecycle } from "../i18n/strings/walletLifecycle";
import { walletStrings } from "../i18n/strings/wallet";
import Callout from "./Callout";

/**
 * A wallet exists but is locked: unlock it with its password. (Creating or importing one is
 * WalletSetup; replacing one that cannot be unlocked any more is under Danger zone.)
 */
export function WalletAccess({ wallet, onChanged }: { wallet: WalletInfo; onChanged: () => void }) {
  const tw = useT(walletStrings);
  const t = useT(walletLifecycle);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const broken = wallet.health?.auto_unlock_ok === false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await unlockWallet(password);
      setPassword("");
      onChanged();
    } catch {
      setError(tw("unlockFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (wallet.unlocked) return null;
  return (
    <form onSubmit={submit} className="setup-form" style={{ maxWidth: 520 }} data-action-id="wallet.unlock">
      <h2>{tw("lockedTitle")}</h2>
      {broken && (
        <Callout tone="error">{wallet.health?.unlock_mode === "env_or_file" ? t("hEnvBroken") : t("hAutoBroken")}</Callout>
      )}
      <p>{tw("lockedBody")}</p>
      <div className="field">
        <label htmlFor="wallet-password">{tw("fieldPassword")}</label>
        <input id="wallet-password" type="password" name="wallet-password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <Callout tone="error">{error}</Callout>}
      <button className="btn" type="submit" disabled={busy || !password}>
        {busy ? tw("unlocking") : tw("unlockButton")}
      </button>
      <p className="field-hint" style={{ marginTop: 12 }}>
        {t("lockedRecovery")}
      </p>
    </form>
  );
}
