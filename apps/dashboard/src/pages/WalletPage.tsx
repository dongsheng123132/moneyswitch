import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { usePolling } from "../usePolling";
import { getWallet, createWallet, unlockWallet } from "../api";
import { formatUsdc, shortAddr } from "../money";
import CopyButton from "../components/CopyButton";
import { SkeletonBlock } from "../components/Skeleton";

// Informational-only constants for the testnet — sourced from
// packages/x402/src/networks.ts TESTNET config (SPEC.md §1 verified facts).
// Not read from the API since GET /v1/admin/wallet does not expose them.
const CHAIN_ID = 10143;
const USDC_CONTRACT = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const EXPLORER_ADDR_BASE = "https://testnet.monadvision.com/address/";

export default function WalletPage() {
  const { data: wallet, error, loading, refresh } = usePolling(getWallet);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setFormError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await createWallet(password);
      setPassword("");
      setConfirmPassword("");
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
      setFormError(e instanceof Error ? e.message : "unlock_failed");
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

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      {!wallet ? (
        <div className="empty-state">Loading...</div>
      ) : !wallet.has_keystore ? (
        <div className="card" style={{ maxWidth: 420 }}>
          <div className="stat-label" style={{ marginBottom: 10 }}>
            No wallet yet — create one
          </div>
          <form onSubmit={onCreate}>
            <div className="field">
              <label>Keystore password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <label>Confirm password</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create wallet"}
            </button>
          </form>
        </div>
      ) : (
        <>
          <div className="grid-2">
            <div className="card">
              <div className="stat-label">Address</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 650, wordBreak: "break-all", margin: "6px 0 10px" }}>
                {wallet.address}
              </div>
              {wallet.address && (
                <div className="btn-group">
                  <CopyButton text={wallet.address} />
                  <a className="btn secondary small" href={EXPLORER_ADDR_BASE + wallet.address} target="_blank" rel="noreferrer">
                    View on explorer
                  </a>
                </div>
              )}

              <div style={{ marginTop: 20, display: "flex", gap: 24, flexWrap: "wrap" }}>
                <div>
                  <div className="stat-label">USDC balance</div>
                  <div className="stat-value num">{wallet.usdc_balance != null ? formatUsdc(wallet.usdc_balance, { maxDecimals: 4 }) : "-"}</div>
                </div>
                <div>
                  <div className="stat-label">Status</div>
                  <div className="stat-value" style={{ fontSize: 16 }}>
                    {wallet.unlocked ? "Unlocked" : "Locked"}
                  </div>
                </div>
              </div>

              <div className="form-section" style={{ marginTop: 22 }}>
                <div className="form-section-title">Network</div>
                <table>
                  <tbody>
                    <tr>
                      <td style={{ color: "var(--text-dim)" }}>Network</td>
                      <td>{wallet.network}</td>
                    </tr>
                    <tr>
                      <td style={{ color: "var(--text-dim)" }}>Chain ID</td>
                      <td className="num">{CHAIN_ID}</td>
                    </tr>
                    <tr>
                      <td style={{ color: "var(--text-dim)" }}>USDC contract</td>
                      <td>
                        <a className="mono" href={EXPLORER_ADDR_BASE + USDC_CONTRACT} target="_blank" rel="noreferrer">
                          {shortAddr(USDC_CONTRACT)}
                        </a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="form-section">
                <div className="form-section-title">How to fund</div>
                <ol className="steps">
                  <li>Copy your wallet address above.</li>
                  <li>Open the Monad testnet faucet and request test MON for gas.</li>
                  <li>Bridge or request testnet USDC to the same address.</li>
                  <li>Balance updates automatically here within a few seconds.</li>
                </ol>
              </div>
            </div>

            <div className="card" style={{ textAlign: "center" }}>
              <div className="stat-label" style={{ marginBottom: 12 }}>
                Scan to copy address
              </div>
              {wallet.address ? (
                <div className="qr-wrap">
                  <QRCodeSVG value={wallet.address} size={168} />
                </div>
              ) : (
                <div className="empty-state">No address yet</div>
              )}
            </div>
          </div>

          {!wallet.unlocked && (
            <div className="card" style={{ maxWidth: 420, marginTop: 16 }}>
              <div className="stat-label" style={{ marginBottom: 10 }}>
                Unlock wallet
              </div>
              <form onSubmit={onUnlock}>
                <div className="field">
                  <label>Keystore password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                {formError && <div className="error-banner">{formError}</div>}
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Unlocking..." : "Unlock"}
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
