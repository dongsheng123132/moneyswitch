import React, { useState } from "react";
import { unlockWallet, type WalletInfo } from "../api";
import { useT } from "../i18n";
import { walletLifecycle } from "../i18n/strings/walletLifecycle";
import { walletStrings } from "../i18n/strings/wallet";
import Callout from "./Callout";
import { isAutoWallet } from "../walletMode";
import { secretReasonText } from "./WalletHealth";
import { ReplaceSection } from "./WalletDangerZone";

/**
 * A wallet exists but is locked: unlock it with its password. (Creating or importing one is
 * WalletSetup; replacing one that cannot be unlocked any more is under Danger zone.)
 *
 * An auto-unlock wallet HAS NO PASSWORD (its keystore is encrypted with a random secret kept on the server), so a
 * locked one never gets a password form: it gets the reason its secret did not work and what can be done about it.
 */
export function WalletAccess({ wallet, onChanged, embedReplace = false }: { wallet: WalletInfo; onChanged: () => void; embedReplace?: boolean }) {
  const tw = useT(walletStrings);
  const t = useT(walletLifecycle);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const broken = wallet.health?.auto_unlock_ok === false;
  const autoWallet = isAutoWallet(wallet);

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
  if (autoWallet) {
    const failure = wallet.health?.unlock_sources?.find((source) => source.source === "auto" && !source.ok);
    const envFailed = wallet.health?.unlock_sources?.some((source) => source.source === "env_or_file" && !source.ok);
    return (
      <section className="setup-form" style={{ maxWidth: 520 }} data-testid="auto-locked" id="wallet-unlock">
        <h2>{tw("lockedTitle")}</h2>
        <Callout tone="error">{secretReasonText(t, failure?.reason)}</Callout>
        {envFailed && <Callout tone="warn">{t("hEnvStale")}</Callout>}
        <p>{t("autoLockedBody")}</p>
        {embedReplace && <EmbeddedReplace wallet={wallet} onChanged={onChanged} />}
      </section>
    );
  }
  return (
    <form onSubmit={submit} className="setup-form" style={{ maxWidth: 520 }} data-action-id="wallet.unlock" id="wallet-unlock">
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
        {embedReplace ? t("lockedRecoveryHere") : t("lockedRecovery")}
      </p>
      {embedReplace && <EmbeddedReplace wallet={wallet} onChanged={onChanged} />}
    </form>
  );
}

/**
 * The setup guide has no Danger zone, and a wallet whose password is lost must not be a dead end there: the Replace action
 * (which only moves files and needs no password) sits right under the unlock form.
 */
function EmbeddedReplace({ wallet, onChanged }: { wallet: WalletInfo; onChanged: () => void }) {
  const t = useT(walletLifecycle);
  return (
    <details className="advanced-details" data-testid="embedded-replace">
      <summary>{t("replaceEmbedSummary")}</summary>
      <ReplaceSection wallet={wallet} onChanged={onChanged} />
    </details>
  );
}
