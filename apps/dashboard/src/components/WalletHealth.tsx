import React from "react";
import { Link } from "react-router-dom";
import type { UnlockFailureReason, WalletHealth, WalletInfo } from "../api";
import { useT, type TFunction } from "../i18n";
import { walletLifecycle } from "../i18n/strings/walletLifecycle";
import { formatUsdc, ratioMicros, toMicros } from "../money";
import Callout from "./Callout";
import Pill from "./Pill";
import ProgressBar from "./ProgressBar";

type Tone = "green" | "red" | "yellow" | "gray";
type Translate = TFunction<keyof (typeof walletLifecycle)["en"] & string>;

/** The reason the wallet's own unlock secret did not open it, in words (the generic text for a server that does not say). */
export function secretReasonText(t: Translate, reason: UnlockFailureReason | undefined): string {
  switch (reason) {
    case "secret_missing":
      return t("hSecretMissing");
    case "secret_empty":
      return t("hSecretEmpty");
    case "secret_unreadable":
      return t("hSecretUnreadable");
    case "secret_wrong":
      return t("hSecretWrong");
    default:
      return t("hAutoBroken");
  }
}

/** Auto wallets: the secret file is gone although the wallet is open right now, so the NEXT restart leaves it locked. */
export function secretGoneWhileRunning(health: WalletHealth): boolean {
  return health.protection === "auto" && health.secret_file_present === false && health.auto_unlock_ok !== false;
}

/** Row 1: will the wallet be open after a restart, and if not, which source failed and why (each source on its own). */
export function unlockSummary(health: WalletHealth, t: Translate): { tone: Tone; pill: string; text: string; note: string | null } {
  if (health.unlock_mode === "manual") return { tone: "yellow", pill: t("pillManual"), text: t("hManual"), note: null };
  const legacy = health.unlock_mode === "env_or_file";
  const sources = health.unlock_sources ?? [];
  const autoFailure = sources.find((s) => s.source === "auto" && !s.ok);
  const envFailure = sources.find((s) => s.source === "env_or_file" && !s.ok);
  // A stale environment password is reported in its own words and never mixed up with the secret.
  const envNote = envFailure ? t("hEnvStale") : null;
  if (health.auto_unlock_ok === false) {
    if (legacy) return { tone: "red", pill: t("pillBroken"), text: t("hEnvBroken"), note: null };
    return { tone: "red", pill: t("pillBroken"), text: secretReasonText(t, autoFailure?.reason), note: envNote };
  }
  if (secretGoneWhileRunning(health)) return { tone: "red", pill: t("pillBroken"), text: t("hSecretGone"), note: envNote };
  if (health.auto_unlock_ok === true) return { tone: "green", pill: t("pillOk"), text: legacy ? t("hEnvOk") : t("hAutoOk"), note: envNote };
  return { tone: "gray", pill: t("pillOk"), text: legacy ? t("hEnvUntested") : t("hAutoUntested"), note: envNote };
}

/**
 * The questions that decide whether money can get stuck or be taken: will the wallet be open after a
 * restart, is the unlock secret protected from other accounts, is the recovery phrase written down, and
 * is more at risk than a hot wallet should hold.
 * Reads GET /v1/admin/wallet → health; renders nothing against an older server that has none.
 */
export function WalletHealthCard({ wallet }: { wallet: WalletInfo }) {
  const t = useT(walletLifecycle);
  const health = wallet.health;
  if (!health || health.unlock_mode === "none") return null;

  // 1. unlock after a restart
  const unlock = unlockSummary(health, t);
  const [unlockTone, unlockPill, unlockText] = [unlock.tone, unlock.pill, unlock.text];

  // 1b. who can read the unlock secret (auto-unlock wallets only; null = nothing on disk to protect)
  const protectedState = health.secret_protected ?? null;

  // 2. recovery phrase backup
  const [backupTone, backupPill, backupText]: [Tone, string, string] =
    health.backup === "confirmed"
      ? ["green", t("pillOk"), t("hBackupConfirmed")]
      : health.backup === "missing"
      ? ["yellow", t("pillAction"), t("hBackupMissing")]
      : ["gray", t("pillNA"), t("hBackupNA")];

  // 3. balance vs float limit (selected network)
  const balance = wallet.usdc_balance;
  const over = health.over_float_limit[wallet.network] === true;
  const ratio = balance === null ? 0 : ratioMicros(toMicros(balance), toMicros(health.float_limit));

  return (
    <section className="card wallet-health" aria-labelledby="wallet-health-title" data-testid="wallet-health">
      <h3 id="wallet-health-title">{t("healthTitle")}</h3>
      <ul className="wallet-health-list">
        <li data-health="unlock">
          <div className="wallet-health-head">
            <span className="wallet-health-label">{t("hAutoUnlock")}</span>
            <Pill tone={unlockTone}>{unlockPill}</Pill>
          </div>
          <div className="wallet-health-text">{unlockText}</div>
          {unlock.note && <div className="wallet-health-text">{unlock.note}</div>}
        </li>
        {protectedState !== null && (
          <li data-health="protect">
            <div className="wallet-health-head">
              <span className="wallet-health-label">{t("hProtect")}</span>
              {protectedState ? <Pill tone="green">{t("pillOk")}</Pill> : <Pill tone="red">{t("pillExposed")}</Pill>}
            </div>
            {protectedState ? (
              <div className="wallet-health-text">{t("hProtectOk")}</div>
            ) : (
              <Callout tone="error" title={t("hProtectBadTitle")}>
                {t("hProtectBad", { detail: health.secret_protection_detail ?? t("hProtectNoDetail") })}
              </Callout>
            )}
          </li>
        )}
        <li data-health="backup">
          <div className="wallet-health-head">
            <span className="wallet-health-label">{t("hBackup")}</span>
            <Pill tone={backupTone}>{backupPill}</Pill>
          </div>
          <div className="wallet-health-text">{backupText}</div>
        </li>
        <li data-health="float">
          <div className="wallet-health-head">
            <span className="wallet-health-label">{t("hFloat")}</span>
            {balance === null ? <Pill tone="gray">?</Pill> : over ? <Pill tone="red">{t("pillOver")}</Pill> : <Pill tone="green">{t("pillOk")}</Pill>}
          </div>
          {balance === null ? (
            <div className="wallet-health-text">{t("hFloatUnknown")}</div>
          ) : (
            <>
              <div className="wallet-health-text num">{t("hFloatLine", { balance: formatUsdc(balance, { maxDecimals: 4 }), limit: formatUsdc(health.float_limit, { maxDecimals: 4 }) })}</div>
              <ProgressBar ratio={ratio} />
            </>
          )}
          {over && (
            <Callout tone="warn">{t("hFloatOver")}</Callout>
          )}
          <div className="field-hint">{t("hFloatHint")}</div>
        </li>
      </ul>
    </section>
  );
}

export type WalletBannerKind = "autoBroken" | "secretUnprotected" | "backupMissing";

/** Which warnings the Overview shows for this wallet (none in the offline demo, whose wallet holds nothing real). */
export function walletBannerKinds(wallet: WalletInfo | null | undefined, demo = false): WalletBannerKind[] {
  const health = wallet?.health;
  if (!wallet || !health || demo || wallet.simulated) return [];
  const kinds: WalletBannerKind[] = [];
  if (health.auto_unlock_ok === false || secretGoneWhileRunning(health)) kinds.push("autoBroken");
  if (health.secret_protected === false) kinds.push("secretUnprotected");
  if (health.backup === "missing") kinds.push("backupMissing");
  return kinds;
}

export function WalletBanners({ wallet, demo = false }: { wallet: WalletInfo | null | undefined; demo?: boolean }) {
  const t = useT(walletLifecycle);
  const kinds = walletBannerKinds(wallet, demo);
  return (
    <>
      {kinds.includes("autoBroken") && (
        <Callout
          tone="error"
          action={
            <Link className="btn small secondary" to="/wallet">
              {t("bannerAutoAction")}
            </Link>
          }
        >
          {t("bannerAutoBroken")}
        </Callout>
      )}
      {kinds.includes("secretUnprotected") && (
        <Callout
          tone="error"
          action={
            <Link className="btn small secondary" to="/wallet">
              {t("bannerProtectAction")}
            </Link>
          }
        >
          {t("bannerSecretUnprotected")}
        </Callout>
      )}
      {kinds.includes("backupMissing") && (
        <Callout
          tone="warn"
          action={
            <Link className="btn small secondary" to="/wallet">
              {t("bannerBackupAction")}
            </Link>
          }
        >
          {t("bannerBackupMissing")}
        </Callout>
      )}
    </>
  );
}
