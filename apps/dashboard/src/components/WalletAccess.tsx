import React, { useRef, useState } from "react";
import { backupWallet, createWallet, importWallet, unlockWallet, type WalletInfo } from "../api";
import { defineMessages, useT } from "../i18n";
import { walletStrings } from "../i18n/strings/wallet";
import Callout from "./Callout";

const messages = defineMessages({
  title: "Set up your payment wallet", mode: "Wallet setup method",
  create: "Create a new wallet", privateKey: "Import private key", restore: "Restore encrypted backup",
  dedicated: "Use a dedicated wallet with a small balance for AI payments.",
  key: "Private key", file: "Encrypted wallet file (.json)", sourcePassword: "Backup password",
  newPassword: "New wallet password", import: "Import wallet", working: "Working…",
  saved: "I have saved this wallet password separately.",
  reminder: "Keep the password and download an encrypted backup before adding funds. A backup still needs its password; the administrator token cannot unlock it.",
  importFailed: "Could not import this wallet. Check the private key or the backup and its password. Existing wallets cannot be replaced.",
  fileInvalid: "Choose a valid wallet JSON file smaller than 128 KB.",
  backupTitle: "Back up your wallet before adding funds", backup: "Download encrypted backup",
  backupDone: "Backup download requested. Keep the file and its password separately.",
  backupFailed: "Could not download the backup. Please try again.",
  recovery: "Forgot your password? An encrypted backup needs the same password. If you separately saved the original private key, import it into a new instance. Creating another wallet does not move the old balance.",
}, {
  title: "设置付款钱包", mode: "钱包设置方式",
  create: "新建钱包", privateKey: "导入私钥", restore: "恢复加密备份",
  dedicated: "建议使用专门给 AI 付款的小额钱包。",
  key: "私钥", file: "加密钱包文件（.json）", sourcePassword: "备份文件的原密码",
  newPassword: "设置新的钱包密码", import: "导入钱包", working: "处理中…",
  saved: "我已另行保存这个钱包密码。",
  reminder: "充值前，请保存密码并下载加密备份。备份文件仍需要密码解锁，管理员 Token 不能代替钱包密码。",
  importFailed: "导入失败，请检查私钥，或备份文件及其原密码。已有钱包不能被覆盖。",
  fileInvalid: "请选择小于 128 KB 的有效钱包 JSON 文件。",
  backupTitle: "充值前先备份钱包", backup: "下载加密备份",
  backupDone: "已发起备份下载，请将文件和密码分开保管。",
  backupFailed: "备份下载失败，请重试。",
  recovery: "忘记密码？加密备份仍需要原密码。如果另存过原始私钥，可以在新实例中导入。新建钱包不会转移旧钱包里的余额。",
});

/** Shared by initial setup and the wallet page; business actions use the same API. */
export function WalletAccess({ wallet, onChanged }: { wallet: WalletInfo; onChanged: () => void }) {
  const t = useT(messages);
  const tw = useT(walletStrings);
  const [mode, setMode] = useState("create");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [keystore, setKeystore] = useState("");
  const [sourcePassword, setSourcePassword] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRead = useRef(0);
  const existing = wallet.has_keystore;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!existing && password.length < 8) return setError(tw("passwordTooShort"));
    if (!existing && password !== confirm) return setError(tw("passwordMismatch"));
    if (!existing && !saved) return;
    setBusy(true);
    try {
      if (existing) await unlockWallet(password);
      else if (mode === "create") await createWallet(password);
      else if (mode === "private_key") await importWallet({ kind: "private_key", private_key: privateKey }, password);
      else await importWallet({ kind: "keystore", keystore, source_password: sourcePassword }, password);
      setPassword(""); setConfirm(""); setPrivateKey(""); setKeystore(""); setSourcePassword("");
      onChanged();
    } catch {
      setError(existing ? tw("unlockFailed") : t("importFailed"));
    } finally { setBusy(false); }
  }

  if (wallet.unlocked) return null;
  return <form onSubmit={submit} className="setup-form" style={{ maxWidth: 520 }} data-action-id={existing ? "wallet.unlock" : mode === "create" ? "wallet.create" : "wallet.import"}>
    <h2>{existing ? tw("lockedTitle") : t("title")}</h2>
    <p>{existing ? tw("lockedBody") : t("dedicated")}</p>
    {!existing && <div className="field">
      <label htmlFor="wallet-method">{t("mode")}</label>
      <select id="wallet-method" value={mode} disabled={busy} onChange={e => { fileRead.current++; setMode(e.target.value); setPrivateKey(""); setKeystore(""); setSourcePassword(""); setError(null); }}>
        <option value="create">{t("create")}</option><option value="private_key">{t("privateKey")}</option><option value="keystore">{t("restore")}</option>
      </select>
    </div>}
    {!existing && mode === "private_key" && <div className="field">
      <label htmlFor="wallet-import-key">{t("key")}</label>
      <input id="wallet-import-key" type="password" autoComplete="off" spellCheck={false} required value={privateKey} onChange={e => setPrivateKey(e.target.value)} />
    </div>}
    {!existing && mode === "keystore" && <>
      <div className="field"><label htmlFor="wallet-import-file">{t("file")}</label>
        <input id="wallet-import-file" type="file" accept=".json,application/json" required disabled={busy} onChange={async e => {
          const version = ++fileRead.current;
          const file = e.target.files?.[0]; setKeystore(""); setError(null);
          if (!file) return;
          if (file.size > 128_000) return setError(t("fileInvalid"));
          try { const text = await file.text(); JSON.parse(text); if (fileRead.current === version) setKeystore(text); } catch { if (fileRead.current === version) setError(t("fileInvalid")); }
        }} />
      </div>
      <div className="field"><label htmlFor="wallet-source-password">{t("sourcePassword")}</label>
        <input id="wallet-source-password" type="password" autoComplete="off" required value={sourcePassword} onChange={e => setSourcePassword(e.target.value)} />
      </div>
    </>}
    <div className="field"><label htmlFor="wallet-password">{existing ? tw("fieldPassword") : t("newPassword")}</label>
      <input id="wallet-password" type="password" name="wallet-password" autoComplete={existing ? "current-password" : "new-password"} minLength={existing ? undefined : 8} required value={password} onChange={e => { setPassword(e.target.value); setSaved(false); }} />
    </div>
    {!existing && <>
      <div className="field"><label htmlFor="wallet-confirm-password">{tw("fieldConfirmPassword")}</label>
        <input id="wallet-confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={e => setConfirm(e.target.value)} />
      </div>
      <p className="field-hint">{t("reminder")}</p>
      <label className="setup-check"><input type="checkbox" checked={saved} required onChange={e => setSaved(e.target.checked)} />{t("saved")}</label>
    </>}
    {error && <Callout tone="error">{error}</Callout>}
    <button className="btn" type="submit" disabled={busy || (!existing && (!saved || (mode === "keystore" && !keystore)))}>
      {busy ? t("working") : existing ? tw("unlockButton") : mode === "create" ? t("create") : t("import")}
    </button>
    {existing && <p className="field-hint" style={{ marginTop: 12 }}>{t("recovery")}</p>}
  </form>;
}

export function WalletBackup() {
  const t = useT(messages);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  async function download() {
    setBusy(true); setError(false); setDone(false);
    try {
      const { keystore, address } = await backupWallet();
      const url = URL.createObjectURL(new Blob([keystore], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `moneyswitch-wallet-${address}.json`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDone(true);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <section className="card" style={{ marginBottom: 16 }}>
    <h3>{t("backupTitle")}</h3><p>{t("reminder")}</p>
    <button type="button" className="btn secondary" data-action-id="wallet.backup" disabled={busy} onClick={download}>{busy ? t("working") : t("backup")}</button>
    {done && <p role="status">{t("backupDone")}</p>}
    {error && <Callout tone="error">{t("backupFailed")}</Callout>}
  </section>;
}
