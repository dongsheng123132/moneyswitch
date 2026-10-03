import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  backupWallet,
  listRetiredWallets,
  replaceWallet,
  setAutoUnlock,
  type ReplaceReason,
  type RetiredWalletRow,
  type RevealedWalletSecret,
  type WalletImport,
  type WalletInfo,
} from "../api";
import { freshPhrase } from "../freshPhrase";
import { useT } from "../i18n";
import { useDateTime } from "../i18n/format";
import { walletLifecycle } from "../i18n/strings/walletLifecycle";
import { formatUsdc } from "../money";
import Callout from "./Callout";
import CopyButton from "./CopyButton";
import { secretGoneWhileRunning } from "./WalletHealth";
import { ExpectedAddressField, ImportWarning, PhraseWords, RevealForm } from "./WalletSetup";

/** The recorded protection mode; an older server that does not send it is judged by what it calls the unlock mode. */
function isAutoWallet(wallet: WalletInfo): boolean {
  const health = wallet.health;
  if (!health) return false;
  return health.protection === "auto" || (health.protection === undefined && health.unlock_mode === "auto");
}

/**
 * Everything that recovers, protects or replaces the wallet, behind one collapsed section. Each action
 * states its consequence in plain words; the destructive ones (reveal, replace) need the wallet address
 * typed in full.
 */
export function WalletDangerZone({ wallet, onChanged }: { wallet: WalletInfo; onChanged: () => void }) {
  const t = useT(walletLifecycle);
  const health = wallet.health;
  // A wallet that cannot open itself (locked, or its unlock secret is broken or gone) or whose secret is exposed is when people need this section most.
  const needsAttention = !wallet.unlocked || health?.auto_unlock_ok === false || (health ? secretGoneWhileRunning(health) : false) || health?.secret_protected === false;
  // Starts open when it is needed; after that the operator's own opening and closing wins (the 3 s polls must not fold it away mid-action).
  const [open, setOpen] = useState(needsAttention);
  return (
    <section className="card wallet-danger" aria-labelledby="wallet-danger-title" data-testid="wallet-danger-zone">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary id="wallet-danger-title">{t("dangerTitle")}</summary>
        <p className="field-hint">{t("dangerLead")}</p>
        {/* keyed by address: a revealed phrase belongs to ONE wallet and must not stay on screen after it is replaced */}
        {health?.backup === "missing" ? (
          // The address is shown nowhere until the backup is confirmed, so it cannot be typed here: the guided backup above does the job.
          <div className="wallet-danger-item" data-section="reveal">
            <h4>{t("revealTitle")}</h4>
            <p>{t("revealUseBackupFlow")}</p>
          </div>
        ) : (
          <RevealSection key={`reveal-${wallet.address}`} />
        )}
        {health && health.unlock_mode !== "none" && <AutoUnlockSection wallet={wallet} onChanged={onChanged} />}
        <DownloadBackupSection wallet={wallet} />
        <ReplaceSection wallet={wallet} onChanged={onChanged} />
        <RetiredWallets network={wallet.network} refreshKey={health?.retired_wallets.length ?? 0} />
      </details>
    </section>
  );
}

/** A revealed phrase / key disappears from the page by itself after this long. */
const REVEAL_VISIBLE_MS = 60_000;

function RevealSection() {
  const t = useT(walletLifecycle);
  const [secret, setSecret] = useState<RevealedWalletSecret | null>(null);
  useEffect(() => {
    if (!secret) return;
    const timer = setTimeout(() => setSecret(null), REVEAL_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [secret]);
  return (
    <div className="wallet-danger-item" data-section="reveal">
      <h4>{t("revealTitle")}</h4>
      <p>{t("revealBody")}</p>
      {secret ? (
        <div>
          {secret.kind === "mnemonic" ? (
            <>
              <div className="stat-label">{t("revealedPhrase")}</div>
              <PhraseWords phrase={secret.recovery_phrase} />
              <div className="btn-group">
                <CopyButton text={secret.recovery_phrase} label={t("phraseCopy")} />
                <button type="button" className="btn secondary" onClick={() => setSecret(null)}>
                  {t("hideButton")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="stat-label">{t("revealedKey")}</div>
              <code className="key-big">{secret.private_key}</code>
              <div className="btn-group">
                <CopyButton text={secret.private_key} />
                <button type="button" className="btn secondary" onClick={() => setSecret(null)}>
                  {t("hideButton")}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <RevealForm onRevealed={setSecret} submitLabel={t("revealButton")} />
      )}
    </div>
  );
}

function AutoUnlockSection({ wallet, onChanged }: { wallet: WalletInfo; onChanged: () => void }) {
  const t = useT(walletLifecycle);
  const mode = wallet.health?.unlock_mode;
  const broken = wallet.health ? wallet.health.auto_unlock_ok === false || secretGoneWhileRunning(wallet.health) : false;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, success: string) {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      await action();
      setPassword("");
      setConfirm("");
      setDone(success);
      onChanged();
    } catch {
      setError(t("autoFailed"));
    } finally {
      setBusy(false);
    }
  }

  function turnOff(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError(t("passwordTooShort"));
    if (password !== confirm) return setError(t("passwordMismatch"));
    void run(() => setAutoUnlock(false, password), t("autoOffDone"));
  }

  return (
    <div className="wallet-danger-item" data-section="auto-unlock">
      <h4>{t("autoTitle")}</h4>
      {mode === "auto" ? (
        <>
          <p>{t("autoOnBody")}</p>
          {broken && wallet.unlocked && (
            <>
              <Callout tone="warn">{t("autoRepairBody")}</Callout>
              <button type="button" className="btn" disabled={busy} onClick={() => run(() => setAutoUnlock(true), t("autoOnDone"))}>
                {t("autoRepairButton")}
              </button>
            </>
          )}
          <p>{t("autoOffBody")}</p>
          <form onSubmit={turnOff}>
            <div className="field">
              <label htmlFor="auto-off-password">{t("newPassword")}</label>
              <input id="auto-off-password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="auto-off-confirm">{t("confirmPassword")}</label>
              <input id="auto-off-confirm" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <p className="field-hint">{t("autoOffNote")}</p>
            <button type="submit" className="btn secondary" disabled={busy || !wallet.unlocked}>
              {t("autoOffButton")}
            </button>
          </form>
        </>
      ) : (
        <>
          <p>{mode === "env_or_file" ? t("autoEnvBody") : t("autoManualBody")}</p>
          <p>{t("autoOnBody")}</p>
          <button type="button" className="btn secondary" disabled={busy || !wallet.unlocked} onClick={() => run(() => setAutoUnlock(true), t("autoOnDone"))}>
            {t("autoOnButton")}
          </button>
        </>
      )}
      {!wallet.unlocked && <div className="field-hint">{t("autoNeedUnlock")}</div>}
      {error && <Callout tone="error">{error}</Callout>}
      {done && <Callout tone="success">{done}</Callout>}
    </div>
  );
}

function DownloadBackupSection({ wallet }: { wallet: WalletInfo }) {
  const t = useT(walletLifecycle);
  // The RECORDED mode decides: an auto wallet's own wallet.json needs a secret nobody is shown, so a portable copy needs a password.
  const [needsPassword, setNeedsPassword] = useState(isAutoWallet(wallet));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  async function download(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setState("idle");
    try {
      const { keystore, address } = await backupWallet(needsPassword ? password : undefined);
      const url = URL.createObjectURL(new Blob([keystore], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `moneyswitch-wallet-${address}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPassword("");
      setState("done");
    } catch (err) {
      if (err instanceof ApiError && err.error === "BACKUP_NEEDS_PASSWORD") setNeedsPassword(true);
      setState("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wallet-danger-item" data-section="backup">
      <h4>{t("backupDlTitle")}</h4>
      <p>{needsPassword ? t("backupDlBodyAuto") : t("backupDlBodyManual")}</p>
      <form onSubmit={download}>
        {needsPassword && (
          <div className="field">
            <label htmlFor="backup-password">{t("backupDlPassword")}</label>
            <input id="backup-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        )}
        <button type="submit" className="btn secondary" data-action-id="wallet.backup" disabled={busy || (needsPassword && !wallet.unlocked)}>
          {busy ? t("working") : t("backupDlButton")}
        </button>
      </form>
      {state === "done" && <p role="status">{t("backupDlDone")}</p>}
      {state === "failed" && <Callout tone="error">{t("backupDlFailed")}</Callout>}
    </div>
  );
}

type ReplaceWith = "create" | "mnemonic" | "private_key";

/** (`initialWith` only lets a render test start on an import variant.) */
export function ReplaceSection({ wallet, onChanged, initialWith = "create" }: { wallet: WalletInfo; onChanged: () => void; initialWith?: ReplaceWith }) {
  const t = useT(walletLifecycle);
  const [reason, setReason] = useState<ReplaceReason>("lost_password");
  const [withWhat, setWithWhat] = useState<ReplaceWith>(initialWith);
  const [phrase, setPhrase] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [expectedAddress, setExpectedAddress] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (askPassword && password.length < 8) return setError(t("passwordTooShort"));
    if (askPassword && password !== confirm) return setError(t("passwordMismatch"));
    const next: { kind: "create" } | WalletImport =
      withWhat === "create" ? { kind: "create" } : withWhat === "mnemonic" ? { kind: "mnemonic", mnemonic: phrase } : { kind: "private_key", private_key: privateKey };
    setBusy(true);
    try {
      const result = await replaceWallet(address.trim(), reason, next, {
        ...(askPassword ? { password } : {}),
        ...(withWhat !== "create" && expectedAddress.trim() ? { expectedAddress: expectedAddress.trim() } : {}),
      });
      if (result.recovery_phrase) freshPhrase.set(result.address, result.recovery_phrase);
      setAddress("");
      setExpectedAddress("");
      setPhrase("");
      setPrivateKey("");
      setPassword("");
      setConfirm("");
      setDone(true);
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError && err.error === "WALLET_BUSY"
          ? t("replaceBusy")
          : err instanceof ApiError && err.error === "ADDRESS_MISMATCH"
          ? t("replaceMismatch")
          : err instanceof ApiError && err.error === "EXPECTED_ADDRESS_MISMATCH"
          ? t("importMismatch")
          : t("replaceFailed")
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wallet-danger-item" data-section="replace">
      <h4>{t("replaceTitle")}</h4>
      <Callout tone="warn">{t("replaceBody")}</Callout>
      <form onSubmit={submit} autoComplete="off">
        <div className="field">
          <label htmlFor="replace-reason">{t("replaceReason")}</label>
          <select id="replace-reason" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value as ReplaceReason)}>
            <option value="lost_password">{t("reasonLost")}</option>
            <option value="suspected_leak">{t("reasonLeak")}</option>
            <option value="other">{t("reasonOther")}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="replace-with">{t("replaceWith")}</label>
          <select id="replace-with" value={withWhat} disabled={busy} onChange={(e) => setWithWhat(e.target.value as ReplaceWith)}>
            <option value="create">{t("replaceWithCreate")}</option>
            <option value="mnemonic">{t("replaceWithPhrase")}</option>
            <option value="private_key">{t("replaceWithKey")}</option>
          </select>
        </div>
        {withWhat !== "create" && <ImportWarning />}
        {withWhat === "mnemonic" && (
          <div className="field">
            <label htmlFor="replace-phrase">{t("phraseInput")}</label>
            <textarea id="replace-phrase" rows={3} autoComplete="off" autoCapitalize="none" spellCheck={false} required value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </div>
        )}
        {withWhat === "private_key" && (
          <div className="field">
            <label htmlFor="replace-key">{t("keyInput")}</label>
            <input id="replace-key" type="password" autoComplete="off" spellCheck={false} required value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
          </div>
        )}
        {withWhat !== "create" && <ExpectedAddressField id="replace-expected" value={expectedAddress} onChange={setExpectedAddress} disabled={busy} />}
        <label className="setup-check">
          <input type="checkbox" checked={askPassword} disabled={busy} onChange={(e) => setAskPassword(e.target.checked)} />
          {t("advancedToggle")}
        </label>
        {askPassword && (
          <>
            <div className="field">
              <label htmlFor="replace-password">{t("newPassword")}</label>
              <input id="replace-password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="replace-confirm">{t("confirmPassword")}</label>
              <input id="replace-confirm" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="replace-address">{t("replaceTypeAddress")}</label>
          <input id="replace-address" className="mono" spellCheck={false} autoComplete="off" required value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        {error && <Callout tone="error">{error}</Callout>}
        {done && <Callout tone="success">{t("replaceDone")}</Callout>}
        <button type="submit" className="btn danger" data-action-id="wallet.replace" disabled={busy || !address.trim()}>
          {busy ? t("working") : t("replaceButton")}
        </button>
      </form>
    </div>
  );
}

const REASON_KEYS = ["lost_password", "suspected_leak", "other", "replaced"] as const;

/** The list itself: one row per retired wallet with its live balance and a way to recover the funds. */
export function RetiredWalletsList({ rows, error }: { rows: RetiredWalletRow[] | null; error?: boolean }) {
  const t = useT(walletLifecycle);
  const when = useDateTime();
  if (error) return <Callout tone="error">{t("retiredLoadFailed")}</Callout>;
  if (rows === null) return <div className="field-hint">{t("working")}</div>;
  if (rows.length === 0) return <div className="field-hint">{t("retiredEmpty")}</div>;
  return (
    <>
      <table className="wallet-retired-table">
        <thead>
          <tr>
            <th>{t("retiredAddress")}</th>
            <th>{t("retiredAt")}</th>
            <th>{t("retiredReason")}</th>
            <th>{t("retiredBalance")}</th>
            <th>{t("retiredFiles")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.address}-${row.retired_at}`}>
              <td>
                <code className="mono wallet-retired-address">{row.address}</code> <CopyButton text={row.address} className="icon-only" />
              </td>
              <td>{when(row.retired_at)}</td>
              <td>{(REASON_KEYS as readonly string[]).includes(row.reason) ? t(`reason_${row.reason}` as "reason_other") : row.reason}</td>
              <td className="num">{row.usdc_balance === null ? t("retiredUnknown") : `${formatUsdc(row.usdc_balance, { maxDecimals: 4 })} USDC`}</td>
              <td className="mono">
                retired/{row.keystore_file}
                {row.has_secret_file ? " (+ .secret)" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-hint">{t("retiredHint")}</p>
    </>
  );
}

function RetiredWallets({ network, refreshKey }: { network: string; refreshKey: number }) {
  const t = useT(walletLifecycle);
  const [rows, setRows] = useState<RetiredWalletRow[] | null>(null);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await listRetiredWallets(network);
      if (alive.current) {
        setRows(res.retired_wallets);
        setError(false);
      }
    } catch {
      if (alive.current) setError(true);
    }
  }, [network]);

  // balances are RPC reads: once on mount, when a wallet was just retired, and on request (never on the 3 s poll)
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <div className="wallet-danger-item" data-section="retired">
      <h4>{t("retiredTitle")}</h4>
      <RetiredWalletsList rows={rows} error={error} />
      <button type="button" className="btn small secondary" onClick={() => void load()}>
        {t("retiredRefresh")}
      </button>
    </div>
  );
}
