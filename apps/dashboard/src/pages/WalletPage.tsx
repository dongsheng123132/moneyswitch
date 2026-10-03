import React, { useState } from "react";
import { usePolling } from "../usePolling";
import { ApiError, confirmBackup, createWallet, getWallet, replaceWallet, type AdminMeta, type ReplaceReason, type WalletInfo } from "../api";
import { freshPhrase, useFreshPhrase } from "../freshPhrase";
import { formatUsdc } from "../money";
import Callout from "../components/Callout";
import CopyButton from "../components/CopyButton";
import PublicAddress from "../components/PublicAddress";
import { SkeletonBlock } from "../components/Skeleton";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { walletStrings } from "../i18n/strings/wallet";
import { useAdminMeta } from "../useAdminMeta";
import "../styles/wallet.css";

const FAUCET_FALLBACK = "https://faucet.circle.com/";

/**
 * "I wrote them down": the acknowledgement names the wallet whose words are on screen, never just "the current wallet" - a replace can
 * land between showing the words and the click, and the new wallet's words have not been seen by anyone. When the server refuses (409
 * WALLET_CHANGED) nothing is cleared or reloaded, so the words stay where they are.
 */
export async function acknowledgeWords(address: string, onChanged: () => Promise<void> | void): Promise<void> {
  await confirmBackup(address);
  freshPhrase.clear();
  await onChanged();
}

/** Which sentence says why the acknowledgement failed: the wallet was replaced since the words were shown, or any other failure. */
export function ackFailureKey(e: unknown): "phraseAckStale" | "phraseAckFailed" {
  return e instanceof ApiError && e.error === "WALLET_CHANGED" ? "phraseAckStale" : "phraseAckFailed";
}

/** Why a wallet that exists is locked right now, as the key of the sentence that says it (null = it is not locked). */
export function lockedReason(wallet: Pick<WalletInfo, "has_keystore" | "unlocked" | "health">): keyof typeof walletStrings.en | null {
  if (!wallet.has_keystore || wallet.unlocked) return null;
  const sources = wallet.health.unlock_sources;
  if (wallet.health.protection === "password") {
    // a wallet made by an older version: either nobody gave the server its password, or the one it was given is wrong
    return sources.some((s) => s.source === "env_or_file" && !s.ok) ? "locked_env_wrong" : "locked_password";
  }
  const auto = sources.find((s) => s.source === "auto" && !s.ok);
  switch (auto?.reason) {
    case "secret_missing":
      return "locked_secret_missing";
    case "secret_empty":
      return "locked_secret_empty";
    case "secret_unreadable":
      return "locked_secret_unreadable";
    default:
      return "locked_secret_wrong";
  }
}

/**
 * May the wallet be shown as something to send money to? Only an unlocked wallet whose words have been written down (or that has no
 * words to write down, an older wallet made from a bare key). Nobody should fund a wallet that is locked, so every payment fails, or
 * one whose words were never confirmed, which is lost if the data folder is: the address, QR code, balances and the faucet steps
 * stay hidden until then. (The replace form still names the current address, as the wallet that will be retired.)
 */
export function fundingAllowed(wallet: Pick<WalletInfo, "has_keystore" | "unlocked" | "health">): boolean {
  return wallet.has_keystore && wallet.unlocked && wallet.health.backup !== "missing";
}

// ---------------------------------------------------------------------------
// the 12 words
// ---------------------------------------------------------------------------

/** The 12 words, numbered, with the warning that goes with them and the "I wrote it down" step. They exist only in memory, only here. */
export function PhraseCard({ phrase, onAcknowledge }: { phrase: string; onAcknowledge: () => Promise<void> }) {
  const t = useT(walletStrings);
  const [written, setWritten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function done() {
    setBusy(true);
    setError(null);
    try {
      await onAcknowledge();
    } catch (e) {
      const key = ackFailureKey(e);
      setError(key === "phraseAckStale" ? t(key) : t(key, { message: e instanceof Error ? e.message : "request_failed" }));
      setBusy(false);
    }
  }

  return (
    <div className="card wallet-phrase" data-testid="phrase-card">
      <h2>{t("phraseTitle")}</h2>
      <Callout tone="warn" title={t("phraseWarnTitle")}>
        {t("phraseWarnBody")}
      </Callout>
      <ol className="wallet-phrase-grid" aria-label={t("wordsLabel")}>
        {phrase.split(" ").map((word, i) => (
          <li key={i}>
            <span className="wallet-phrase-index">{i + 1}</span>
            <span className="wallet-phrase-word mono">{word}</span>
          </li>
        ))}
      </ol>
      <div className="btn-group">
        <CopyButton text={phrase} label={t("phraseCopy")} />
      </div>
      <label className="wallet-ack">
        <input type="checkbox" checked={written} disabled={busy} onChange={(e) => setWritten(e.target.checked)} />
        {t("phraseAck")}
      </label>
      {error && <Callout tone="error">{error}</Callout>}
      <button type="button" className="btn" disabled={!written || busy} onClick={done}>
        {busy ? t("phraseSaving") : t("phraseDone")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// create (no wallet yet)
// ---------------------------------------------------------------------------

function CreateCard({ wallet, onCreated }: { wallet: WalletInfo; onCreated: () => Promise<void> | void }) {
  const t = useT(walletStrings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ackOrphans, setAckOrphans] = useState(false);
  // wallet.json is missing but credentials of an earlier wallet are still in the data folder: the likely cause is a data folder mounted
  // from the wrong place, not a wish for a brand-new empty wallet. Creating then needs an explicit yes.
  const orphans = wallet.health.orphan_files;
  const orphaned = orphans.wallet_file_missing;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await createWallet();
      freshPhrase.set(created.address, created.recovery_phrase);
      await onCreated();
    } catch (e) {
      setError(t("createFailed", { message: e instanceof ApiError || e instanceof Error ? e.message : "request_failed" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card wallet-setup" aria-labelledby="wallet-setup-title">
      <h2 id="wallet-setup-title">{t("setupTitle")}</h2>
      <p>{t("setupLead")}</p>
      {orphaned && (
        <div data-testid="orphan-warning">
          <Callout tone="error" title={t("orphanTitle")}>
            {t("orphanBody", { secrets: orphans.secrets.length, retired: orphans.retired })}
          </Callout>
          <label className="wallet-ack">
            <input type="checkbox" checked={ackOrphans} disabled={busy} onChange={(e) => setAckOrphans(e.target.checked)} />
            {t("orphanAck")}
          </label>
        </div>
      )}
      <p className="wallet-create-explain">{t("createExplain")}</p>
      {error && <Callout tone="error">{error}</Callout>}
      <button type="button" className="btn" data-action-id="wallet.create" disabled={busy || (orphaned && !ackOrphans)} onClick={create}>
        {busy ? t("creating") : t("createButton")}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function Problems({ wallet }: { wallet: WalletInfo }) {
  const t = useT(walletStrings);
  const h = wallet.health;
  const locked = lockedReason(wallet);
  return (
    <>
      {locked && (
        <Callout tone="error" title={t("lockedTitle")}>
          {t(locked)} {locked.startsWith("locked_secret") ? t("locked_fix") : ""}
        </Callout>
      )}
      {!locked && h.protection === "auto" && h.secret_file_present === false && (
        <Callout tone="warn" title={t("secretGoneTitle")}>
          {t("secretGoneBody")}
        </Callout>
      )}
      {h.secret_protected === false && (
        <Callout tone="warn" title={t("unprotectedTitle")}>
          {t("unprotectedBody", { detail: h.secret_protection_detail ?? "" })}
        </Callout>
      )}
      {h.backup === "missing" && (
        <div data-testid="backup-missing">
          <Callout tone="warn" title={t("backupMissingTitle")}>
            {t("backupMissingBody")}
          </Callout>
        </div>
      )}
      {h.retired_secrets_open_live_key.length > 0 && (
        <Callout tone="warn" title={t("retiredOpenerTitle")}>
          {t("retiredOpenerBody", { files: h.retired_secrets_open_live_key.join(", ") })}
        </Callout>
      )}
      {wallet.has_keystore && (h.orphan_files.secrets.length > 0 || h.orphan_files.retired > 0) && !h.orphan_files.wallet_file_missing && (
        <Callout tone="info" title={t("orphanWalletTitle")}>
          {t("orphanWalletBody", { secrets: h.orphan_files.secrets.length, retired: h.orphan_files.retired })}
        </Callout>
      )}
    </>
  );
}

function AddressCard({ wallet, meta }: { wallet: WalletInfo; meta: AdminMeta | null }) {
  const t = useT(walletStrings);
  const tc = useT(common);
  const limit = wallet.health.float_limit;
  const anyMainnet = wallet.networks.some((n) => n.is_mainnet);
  const anyTestnet = wallet.networks.some((n) => !n.is_mainnet);
  return (
    <div className="card">
      <h2>{t("addressTitle")}</h2>
      {wallet.address && <PublicAddress address={wallet.address} qr="toggle" size="lg" />}
      <p className="wallet-lead">{t("addressLead")}</p>
      <table className="wallet-networks">
        <thead>
          <tr>
            <th>{t("chainCol")}</th>
            <th className="num">{t("balanceCol")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {wallet.networks.map((n) => (
            <tr key={n.network} data-network={n.network}>
              <td>{n.label}</td>
              <td className="num">
                {n.usdc_balance == null ? <span className="dim">{t("balanceUnknown")}</span> : `${formatUsdc(n.usdc_balance, { maxDecimals: 4 })} ${tc("usdc")}`}
                {n.over_float_limit && <div className="wallet-over-limit">{t("overLimit", { limit })}</div>}
              </td>
              <td>
                {wallet.address && (
                  <a href={`${n.explorer_base}/address/${wallet.address}`} target="_blank" rel="noreferrer">
                    {t("viewExplorer")}
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="wallet-lead">{t("floatNote", { limit })}</p>
      {anyTestnet && (
        <p className="wallet-lead">
          {t("fundTestnet")}{" "}
          <a href={meta?.faucet_url || FAUCET_FALLBACK} target="_blank" rel="noreferrer">
            {t("fundFaucet")}
          </a>
        </p>
      )}
      {anyMainnet && <p className="wallet-lead">{t("fundMainnet")}</p>}
    </div>
  );
}

function Checks({ wallet }: { wallet: WalletInfo }) {
  const t = useT(walletStrings);
  const h = wallet.health;
  const unlockOk = wallet.unlocked && (h.auto_unlock_ok === true || h.unlock_mode === "env_or_file");
  const protect = h.secret_protected === null ? t("notApplicable") : h.secret_protected ? t("yes") : t("notVerified", { detail: h.secret_protection_detail ?? "" });
  const backup = h.backup === "confirmed" ? t("yes") : h.backup === "missing" ? t("notConfirmed") : t("notApplicable");
  return (
    <div className="card">
      <h2>{t("checksTitle")}</h2>
      <dl className="wallet-checks">
        <div>
          <dt>{t("checkUnlock")}</dt>
          <dd data-check="unlock">{unlockOk ? t("yes") : t("no")}</dd>
        </div>
        <div>
          <dt>{t("checkProtect")}</dt>
          <dd data-check="protect">{protect}</dd>
        </div>
        <div>
          <dt>{t("checkBackup")}</dt>
          <dd data-check="backup">{backup}</dd>
        </div>
      </dl>
    </div>
  );
}

function RetiredCard({ wallet }: { wallet: WalletInfo }) {
  const t = useT(walletStrings);
  const tc = useT(common);
  if (wallet.retired_wallets.length === 0) return null;
  return (
    <div className="card" data-testid="retired-wallets">
      <h2>{t("retiredTitle")}</h2>
      <p className="wallet-lead">{t("retiredLead")}</p>
      <table>
        <thead>
          <tr>
            <th>{t("retiredAddress")}</th>
            <th>{t("retiredOn")}</th>
            <th>{t("retiredReason")}</th>
            <th className="num">{t("retiredBalance")}</th>
            <th>{t("retiredFiles")}</th>
          </tr>
        </thead>
        <tbody>
          {wallet.retired_wallets.map((r) => (
            <tr key={`${r.address}-${r.retired_at}`}>
              <td className="mono">{r.address}</td>
              <td>{r.retired_at.slice(0, 10)}</td>
              <td className="mono">{r.reason}</td>
              <td className="num">
                {wallet.networks.map((n) => (
                  <div key={n.network}>
                    {n.label}: {r.balances[n.network] == null ? t("balanceUnknown") : `${formatUsdc(r.balances[n.network], { maxDecimals: 4 })} ${tc("usdc")}`}
                  </div>
                ))}
              </td>
              <td>{r.has_secret_file ? t("retiredFilesKeystoreAndSecret") : t("retiredFilesKeystore")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// replace
// ---------------------------------------------------------------------------

const REASONS: ReplaceReason[] = ["replaced", "lost_password", "suspected_leak"];

function ReplaceCard({ wallet, onReplaced }: { wallet: WalletInfo; onReplaced: () => Promise<void> | void }) {
  const t = useT(walletStrings);
  const [reason, setReason] = useState<ReplaceReason>("replaced");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = wallet.address ?? "";

  async function replace(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const replaced = await replaceWallet(confirm.trim(), reason);
      // The words exist nowhere else: put them away before anything else can go wrong. They are shown as soon as the page shows the
      // new wallet (the refresh below), and held, never dropped, until then.
      freshPhrase.set(replaced.address, replaced.recovery_phrase);
      setConfirm("");
      await onReplaced();
    } catch (err) {
      const code = err instanceof ApiError ? err.error : null;
      setError(
        code === "WALLET_BUSY" ? t("replaceBusy") : code === "ADDRESS_MISMATCH" ? t("replaceMismatch") : t("replaceFailed", { message: err instanceof Error ? err.message : "request_failed" })
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card wallet-danger" data-testid="replace-wallet">
      <summary>{t("replaceTitle")}</summary>
      <p>{t("replaceLead")}</p>
      <p>{t("replaceMoveMoney")}</p>
      <p className="wallet-current">
        {t("replaceCurrentLabel")}{" "}
        <code className="mono" data-testid="replace-current-address">
          {address}
        </code>
      </p>
      <form onSubmit={replace}>
        <div className="field">
          <label htmlFor="replace-reason">{t("replaceReasonLabel")}</label>
          <select id="replace-reason" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value as ReplaceReason)}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reason_${r}` as const)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="replace-confirm">{t("replaceConfirmLabel")}</label>
          <input
            id="replace-confirm"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            placeholder={address}
            value={confirm}
            disabled={busy}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {error && <Callout tone="error">{error}</Callout>}
        <button type="submit" className="btn danger" disabled={busy || confirm.trim() !== address}>
          {busy ? t("replacing") : t("replaceButton")}
        </button>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

/**
 * The Wallet page for a loaded wallet (split from the polling shell so it can be rendered with a given state):
 *  - the 12 words, while they are on screen and not yet acknowledged;
 *  - no wallet yet: "Create wallet";
 *  - a wallet: what is wrong (if anything); its address and balance on every chain once it is unlocked and its words are confirmed
 *    (fundingAllowed); the replaced wallets, and the replace form.
 */
export function WalletView({
  wallet,
  meta,
  error,
  onChanged,
}: {
  wallet: WalletInfo;
  meta: AdminMeta | null;
  error?: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const tc = useT(common);
  // Without a wallet the creation response is the authority; with one, the words are only shown for that very wallet.
  const fresh = useFreshPhrase(wallet.has_keystore ? wallet.address : null);
  const phrase = fresh?.phrase ?? null;

  return (
    <div className="wallet-page">
      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}
      {fresh && <PhraseCard phrase={fresh.phrase} onAcknowledge={() => acknowledgeWords(fresh.address, onChanged)} />}
      {!phrase && !wallet.has_keystore && <CreateCard wallet={wallet} onCreated={onChanged} />}
      {wallet.has_keystore && (
        <>
          <Problems wallet={wallet} />
          {fundingAllowed(wallet) && <AddressCard wallet={wallet} meta={meta} />}
          <Checks wallet={wallet} />
          <RetiredCard wallet={wallet} />
          <ReplaceCard wallet={wallet} onReplaced={onChanged} />
        </>
      )}
    </div>
  );
}

export default function WalletPage() {
  const { data: wallet, error, loading, refresh } = usePolling(getWallet);
  const meta = useAdminMeta();
  const tc = useT(common);
  if (loading && !wallet) {
    return (
      <div className="card">
        <SkeletonBlock height={20} width={260} />
      </div>
    );
  }
  if (!wallet) return error ? <Callout tone="error">{tc("requestFailed", { message: error })}</Callout> : null;
  return <WalletView wallet={wallet} meta={meta} error={error} onChanged={refresh} />;
}
