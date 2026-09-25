import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { usePolling } from "../usePolling";
import { getWallet, createWallet, unlockWallet } from "../api";
import { formatUsdc, shortAddr } from "../money";
import CopyButton from "../components/CopyButton";
import Callout from "../components/Callout";
import Term from "../components/Term";
import { SkeletonBlock } from "../components/Skeleton";
import { useT } from "../i18n";
import { walletStrings } from "../i18n/strings/wallet";
import { common } from "../i18n/strings/common";
import { useAdminMeta } from "../useAdminMeta";
import "../styles/wallet.css";

// Informational-only defaults for the testnet — used only when GET /v1/admin/meta
// hasn't returned yet or doesn't carry a field (SPEC.md §1 verified facts).
const DEFAULT_CHAIN_ID = 10143;
const DEFAULT_USDC_CONTRACT = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const DEFAULT_EXPLORER_BASE = "https://testnet.monadvision.com";
const DEFAULT_FAUCET_URL = "https://faucet.circle.com/";

/**
 * The "how to fund" steps block (docs/ux-audit.md A-3). Exported so the setup
 * wizard can reuse it verbatim; fetches admin meta itself so callers only
 * need to pass the address.
 */
export function FundingGuide({ address }: { address: string }) {
  const t = useT(walletStrings);
  const meta = useAdminMeta();
  const faucetUrl = meta?.faucet_url || DEFAULT_FAUCET_URL;
  return (
    <div className="form-section">
      <div className="form-section-title">{t("fundingTitle")}</div>
      <ol className="wallet-funding-steps steps">
        <li>
          {t("fundingStep1")} <CopyButton text={address} className="icon-only" />
        </li>
        <li>
          {t("fundingStep2Prefix")}
          <a href={faucetUrl} target="_blank" rel="noreferrer">
            {t("fundingStep2Link")}
          </a>
          {t("fundingStep2Suffix")}
        </li>
        <li>{t("fundingStep3")}</li>
      </ol>
      <div className="wallet-funding-notes">
        <div>
          <strong>{t("fundingNoGasTitle")}</strong> — {t("fundingNoGasBody")} <Term k="facilitator">facilitator</Term>.
        </div>
        <div>{t("fundingDemoNote")}</div>
      </div>
    </div>
  );
}

export default function WalletPage() {
  const { data: wallet, error, loading, refresh } = usePolling(getWallet);
  const meta = useAdminMeta();
  const t = useT(walletStrings);
  const tc = useT(common);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createSuccess, setCreateSuccess] = useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (password.length < 8) {
      setFormError(t("passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      setFormError(t("passwordMismatch"));
      return;
    }
    setBusy(true);
    try {
      await createWallet(password);
      setPassword("");
      setConfirmPassword("");
      setCreateSuccess(true);
      refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "create_failed");
    } finally {
      setBusy(false);
    }
  }

  async function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await unlockWallet(password);
      setPassword("");
      refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("unlockFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !wallet) {
    return (
      <div className="card">
        <SkeletonBlock height={20} width={260} />
      </div>
    );
  }

  if (!wallet) {
    return error ? <Callout tone="error">{tc("requestFailed", { message: error })}</Callout> : null;
  }

  const explorerBase = meta?.explorer_base || DEFAULT_EXPLORER_BASE;
  const chainId = meta?.chain_id ?? DEFAULT_CHAIN_ID;
  const usdcContract = meta?.usdc_address || DEFAULT_USDC_CONTRACT;
  const network = meta?.network ?? wallet.network;

  if (!wallet.has_keystore) {
    return (
      <div className="card" style={{ maxWidth: 460 }}>
        <div className="stat-label" style={{ marginBottom: 4 }}>
          <Term k="wallet">{t("createTitle")}</Term>
        </div>
        <p className="stat-sub" style={{ marginBottom: 14 }}>
          {t("createIntro")}
        </p>
        <form onSubmit={onCreate}>
          <div className="field">
            <label>{t("fieldPassword")}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
          </div>
          <div className="field">
            <label>{t("fieldConfirmPassword")}</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} required />
          </div>
          <Callout tone="warn" title={t("passwordWarnTitle")}>
            {t("passwordWarnBody")}
          </Callout>
          {formError && (
            <div style={{ marginTop: 12 }}>
              <Callout tone="error">{formError}</Callout>
            </div>
          )}
          <button className="btn" type="submit" disabled={busy} style={{ marginTop: 14 }}>
            {busy ? t("creating") : t("createButton")}
          </button>
        </form>
        {createSuccess && (
          <div style={{ marginTop: 12 }}>
            <Callout tone="success">{t("createSuccess")}</Callout>
          </div>
        )}
      </div>
    );
  }

  const balance = wallet.usdc_balance;
  const balanceIsZero = balance != null && Number(balance) === 0;
  const balanceIsPositive = balance != null && Number(balance) > 0;

  return (
    <div>
      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}

      {!wallet.unlocked && (
        <div className="card" style={{ maxWidth: 420, marginBottom: 16 }}>
          <div className="stat-label" style={{ marginBottom: 4 }}>
            <Term k="walletLocked">{t("lockedTitle")}</Term>
          </div>
          <p className="stat-sub" style={{ marginBottom: 10 }}>
            {t("lockedBody")}
          </p>
          <form onSubmit={onUnlock}>
            <div className="field">
              <label>{t("fieldPassword")}</label>
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {formError && (
              <div style={{ marginBottom: 10 }}>
                <Callout tone="error">{formError}</Callout>
              </div>
            )}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? t("unlocking") : t("unlockButton")}
            </button>
          </form>
        </div>
      )}

      <div className="wallet-top-cards">
        <div className="card">
          <div className="stat-label">{t("addressLabel")}</div>
          <div className="mono wallet-address-value">{wallet.address ?? "-"}</div>
          {wallet.address && (
            <div className="btn-group">
              <CopyButton text={wallet.address} />
              <a className="btn secondary small" href={`${explorerBase}/address/${wallet.address}`} target="_blank" rel="noreferrer">
                {t("viewOnExplorer")}
              </a>
            </div>
          )}

          <div style={{ marginTop: 20, display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div className="stat-label">{t("balanceLabel")}</div>
              <div className="stat-value num">{balance != null ? formatUsdc(balance, { maxDecimals: 4 }) : "-"}</div>
              <div className="stat-sub">{t("balanceAutoRefresh")}</div>
            </div>
            <div>
              <div className="stat-label">{t("statusLabel")}</div>
              <div className="stat-value" style={{ fontSize: 16 }}>
                {wallet.unlocked ? t("statusUnlocked") : t("statusLocked")}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            {balance == null ? (
              <Callout tone="warn" title={t("balanceUnreadableTitle")}>
                {t("balanceUnreadableBody")}
              </Callout>
            ) : balanceIsPositive ? (
              <Callout tone="success">{t("balanceFunded", { amount: formatUsdc(balance, { maxDecimals: 4 }) })}</Callout>
            ) : balanceIsZero ? (
              <div className="stat-sub">{t("balanceWaiting")}</div>
            ) : null}
          </div>

          <div className="form-section" style={{ marginTop: 22 }}>
            <div className="form-section-title">{t("networkTitle")}</div>
            <table className="wallet-network-table">
              <tbody>
                <tr>
                  <td>{t("networkLabel")}</td>
                  <td>{network}</td>
                </tr>
                <tr>
                  <td>{t("chainIdLabel")}</td>
                  <td className="num">{chainId}</td>
                </tr>
                <tr>
                  <td>{t("usdcContractLabel")}</td>
                  <td>
                    <a className="mono" href={`${explorerBase}/address/${usdcContract}`} target="_blank" rel="noreferrer">
                      {shortAddr(usdcContract)}
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <FundingGuide address={wallet.address ?? ""} />
        </div>

        <div className="card wallet-qr-card">
          <div className="stat-label" style={{ marginBottom: 12 }}>
            {t("qrTitle")}
          </div>
          {wallet.address ? (
            <div className="qr-wrap">
              <QRCodeSVG value={wallet.address} size={168} />
            </div>
          ) : (
            <div className="empty-state">{t("qrEmpty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
