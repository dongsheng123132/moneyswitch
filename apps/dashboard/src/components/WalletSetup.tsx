import React, { useRef, useState } from "react";
import { ApiError, confirmBackup, createWallet, importWallet, revealWallet, type RevealedWalletSecret, type WalletImport } from "../api";
import { freshPhrase, useFreshPhrase } from "../freshPhrase";
import { useT } from "../i18n";
import { walletLifecycle } from "../i18n/strings/walletLifecycle";
import Callout from "./Callout";
import CopyButton from "./CopyButton";

type ImportMethod = "mnemonic" | "private_key" | "keystore";

/** Two different 1-based positions out of `count`, ascending, from the browser's CSPRNG. */
export function pickPositions(count: number): [number, number] {
  const random = new Uint32Array(2);
  globalThis.crypto.getRandomValues(random);
  const first = random[0] % count;
  let second = random[1] % (count - 1);
  if (second >= first) second += 1;
  const [a, b] = first < second ? [first, second] : [second, first];
  return [a + 1, b + 1];
}

/**
 * First step of the wallet: the recommended path has NO password. One button creates the wallet, then
 * the phrase is shown and checked (BackupRequired). Importing an existing wallet and the
 * "ask for a password on every restart" mode are secondary.
 */
export function WalletSetup({ onDone, initialAdvanced = false }: { onDone: () => void; initialAdvanced?: boolean }) {
  const t = useT(walletLifecycle);
  const fresh = useFreshPhrase();
  const [advanced, setAdvanced] = useState(initialAdvanced);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [method, setMethod] = useState<ImportMethod>("mnemonic");
  const [phrase, setPhrase] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [keystore, setKeystore] = useState("");
  const [sourcePassword, setSourcePassword] = useState("");
  const [busy, setBusy] = useState<"create" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRead = useRef(0);

  // The wallet exists and its phrase is on screen: keep showing it through the next polls.
  if (fresh) return <BackupRequired onConfirmed={onDone} />;

  function passwordProblem(): string | null {
    if (!advanced) return null;
    if (password.length < 8) return t("passwordTooShort");
    if (password !== confirm) return t("passwordMismatch");
    return null;
  }

  async function create() {
    setError(null);
    const problem = passwordProblem();
    if (problem) return setError(problem);
    setBusy("create");
    try {
      const created = await createWallet(advanced ? { password } : {});
      freshPhrase.set(created.recovery_phrase);
      setPassword("");
      setConfirm("");
      onDone();
    } catch {
      setError(t("createFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function submitImport(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = passwordProblem();
    if (problem) return setError(problem);
    const source: WalletImport =
      method === "mnemonic"
        ? { kind: "mnemonic", mnemonic: phrase }
        : method === "private_key"
        ? { kind: "private_key", private_key: privateKey }
        : { kind: "keystore", keystore, source_password: sourcePassword };
    setBusy("import");
    try {
      await importWallet(source, advanced ? { password } : {});
      setPhrase("");
      setPrivateKey("");
      setKeystore("");
      setSourcePassword("");
      setPassword("");
      setConfirm("");
      onDone();
    } catch {
      setError(t("importFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="wallet-setup" aria-labelledby="wallet-setup-title">
      <h2 id="wallet-setup-title">{t("setupTitle")}</h2>
      <p>{t("setupLead")}</p>

      <div className="wallet-setup-primary">
        <h3>{t("createRecommended")}</h3>
        <p>{t("createExplain")}</p>
        <button type="button" className="btn" data-action-id="wallet.create" disabled={busy !== null} onClick={create}>
          {busy === "create" ? t("creating") : t("createButton")}
        </button>
      </div>

      <label className="setup-check">
        <input type="checkbox" checked={advanced} disabled={busy !== null} onChange={(e) => setAdvanced(e.target.checked)} />
        {t("advancedToggle")}
      </label>
      <p className="field-hint">{t("advancedHint")}</p>
      {advanced && (
        <div className="wallet-setup-password">
          <div className="field">
            <label htmlFor="wallet-password">{t("newPassword")}</label>
            <input
              id="wallet-password"
              type="password"
              name="wallet-password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="wallet-confirm-password">{t("confirmPassword")}</label>
            <input
              id="wallet-confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        </div>
      )}
      {error && <Callout tone="error">{error}</Callout>}

      <details className="advanced-details wallet-setup-other">
        <summary>{t("otherWays")}</summary>
        <form onSubmit={submitImport} data-action-id="wallet.import">
          <div className="field">
            <label htmlFor="wallet-import-method">{t("importMethod")}</label>
            <select
              id="wallet-import-method"
              value={method}
              disabled={busy !== null}
              onChange={(e) => {
                fileRead.current++;
                setMethod(e.target.value as ImportMethod);
                setPhrase("");
                setPrivateKey("");
                setKeystore("");
                setSourcePassword("");
                setError(null);
              }}
            >
              <option value="mnemonic">{t("methodPhrase")}</option>
              <option value="private_key">{t("methodKey")}</option>
              <option value="keystore">{t("methodKeystore")}</option>
            </select>
          </div>
          {method === "mnemonic" && (
            <div className="field">
              <label htmlFor="wallet-import-phrase">{t("phraseInput")}</label>
              <textarea
                id="wallet-import-phrase"
                rows={3}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
              <div className="field-hint">{t("phraseInputHint")}</div>
            </div>
          )}
          {method === "private_key" && (
            <div className="field">
              <label htmlFor="wallet-import-key">{t("keyInput")}</label>
              <input id="wallet-import-key" type="password" autoComplete="off" spellCheck={false} required value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
            </div>
          )}
          {method === "keystore" && (
            <>
              <div className="field">
                <label htmlFor="wallet-import-file">{t("fileInput")}</label>
                <input
                  id="wallet-import-file"
                  type="file"
                  accept=".json,application/json"
                  required
                  disabled={busy !== null}
                  onChange={async (e) => {
                    const version = ++fileRead.current;
                    const file = e.target.files?.[0];
                    setKeystore("");
                    setError(null);
                    if (!file) return;
                    if (file.size > 128_000) return setError(t("fileInvalid"));
                    try {
                      const text = await file.text();
                      JSON.parse(text);
                      if (fileRead.current === version) setKeystore(text);
                    } catch {
                      if (fileRead.current === version) setError(t("fileInvalid"));
                    }
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor="wallet-source-password">{t("sourcePassword")}</label>
                <input id="wallet-source-password" type="password" autoComplete="off" required value={sourcePassword} onChange={(e) => setSourcePassword(e.target.value)} />
              </div>
            </>
          )}
          <button className="btn secondary" type="submit" disabled={busy !== null || (method === "keystore" && !keystore)}>
            {busy === "import" ? t("working") : t("importButton")}
          </button>
        </form>
      </details>
    </section>
  );
}

/** The words, numbered. */
export function PhraseWords({ phrase }: { phrase: string }) {
  const t = useT(walletLifecycle);
  return (
    <ol className="wallet-phrase-grid" aria-label={t("wordsLabel")}>
      {phrase.split(" ").map((word, i) => (
        <li key={i}>
          <span className="wallet-phrase-index">{i + 1}</span>
          <span className="wallet-phrase-word mono">{word}</span>
        </li>
      ))}
    </ol>
  );
}

/** The 12 words, numbered, with the warning that goes with them. */
export function PhraseView({ phrase, onWritten }: { phrase: string; onWritten: () => void }) {
  const t = useT(walletLifecycle);
  return (
    <div className="wallet-phrase">
      <h3>{t("phraseTitle")}</h3>
      <Callout tone="warn" title={t("phraseWarnTitle")}>
        {t("phraseWarnBody")}
      </Callout>
      <PhraseWords phrase={phrase} />
      <p className="field-hint">{t("phraseCompat")}</p>
      <div className="btn-group">
        <CopyButton text={phrase} label={t("phraseCopy")} />
        <button type="button" className="btn" onClick={onWritten}>
          {t("phraseWritten")}
        </button>
      </div>
    </div>
  );
}

/** Asks for two random words of the phrase (the server checks them). */
export function ConfirmPhrase({ wordCount, onBack, onConfirmed }: { wordCount: number; onBack: () => void; onConfirmed: () => void }) {
  const t = useT(walletLifecycle);
  const [positions] = useState(() => pickPositions(wordCount));
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await confirmBackup(positions, [first.trim().toLowerCase(), second.trim().toLowerCase()]);
      onConfirmed();
    } catch (err) {
      setError(err instanceof ApiError && err.error === "WORDS_MISMATCH" ? t("confirmMismatch") : t("confirmFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wallet-confirm" onSubmit={submit}>
      <h3>{t("confirmTitle")}</h3>
      <p>{t("confirmBody")}</p>
      {[0, 1].map((i) => (
        <div className="field" key={i}>
          <label htmlFor={`wallet-word-${i}`}>{t("wordAt", { n: positions[i] })}</label>
          <input
            id={`wallet-word-${i}`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={i === 0 ? first : second}
            onChange={(e) => (i === 0 ? setFirst(e.target.value) : setSecond(e.target.value))}
          />
        </div>
      ))}
      {error && <Callout tone="error">{error}</Callout>}
      <div className="btn-group">
        <button type="submit" className="btn" data-action-id="wallet.backup.confirm" disabled={busy || !first.trim() || !second.trim()}>
          {busy ? t("confirming") : t("confirmButton")}
        </button>
        <button type="button" className="btn secondary" disabled={busy} onClick={onBack}>
          {t("showAgain")}
        </button>
      </div>
    </form>
  );
}

/**
 * "Type the wallet address to show the secret": the deliberate speed bump in front of the recovery
 * phrase. Used to finish a backup after a page reload and by "Reveal" under Danger zone.
 */
export function RevealForm({
  onRevealed,
  submitLabel,
  children,
}: {
  onRevealed: (secret: RevealedWalletSecret) => void;
  submitLabel?: string;
  children?: React.ReactNode;
}) {
  const t = useT(walletLifecycle);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onRevealed(await revealWallet(address.trim()));
      setAddress("");
    } catch (err) {
      setError(
        err instanceof ApiError && err.error === "ADDRESS_MISMATCH" ? t("revealWrong") : err instanceof ApiError && err.error === "WALLET_LOCKED" ? t("revealLocked") : t("revealFailed")
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wallet-reveal" onSubmit={submit} autoComplete="off">
      {children}
      <div className="field">
        <label htmlFor="wallet-reveal-address">{t("walletAddress")}</label>
        <input id="wallet-reveal-address" className="mono" spellCheck={false} autoComplete="off" required value={address} onChange={(e) => setAddress(e.target.value)} />
        <div className="field-hint">{t("addressHint")}</div>
      </div>
      {error && <Callout tone="error">{error}</Callout>}
      <button type="submit" className="btn" data-action-id="wallet.reveal" disabled={busy || !address.trim()}>
        {submitLabel ?? t("showPhraseButton")}
      </button>
    </form>
  );
}

/**
 * Show the phrase (fresh from creation, or revealed on request), then check two words.
 * Leaves `freshPhrase` cleared once the server has accepted the check.
 */
export function BackupFlow({ onConfirmed }: { onConfirmed: () => void }) {
  const t = useT(walletLifecycle);
  const fresh = useFreshPhrase();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [step, setStep] = useState<"show" | "check">("show");
  const phrase = fresh ?? revealed;

  if (!phrase) {
    return (
      <RevealForm onRevealed={(secret) => secret.kind === "mnemonic" && setRevealed(secret.recovery_phrase)}>
        <p>{t("typeAddress")}</p>
      </RevealForm>
    );
  }
  if (step === "show") return <PhraseView phrase={phrase} onWritten={() => setStep("check")} />;
  return (
    <ConfirmPhrase
      wordCount={phrase.split(" ").length}
      onBack={() => setStep("show")}
      onConfirmed={() => {
        freshPhrase.clear();
        setRevealed(null);
        onConfirmed();
      }}
    />
  );
}

/** What stands where the deposit address would be until the recovery phrase is written down and checked. */
export function BackupRequired({ onConfirmed }: { onConfirmed: () => void }) {
  const t = useT(walletLifecycle);
  return (
    <div className="wallet-backup-required" data-testid="backup-required">
      <Callout tone="warn" title={t("finishBackupTitle")}>
        {t("finishBackupBody")}
      </Callout>
      <BackupFlow onConfirmed={onConfirmed} />
    </div>
  );
}
