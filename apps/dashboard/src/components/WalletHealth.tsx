import React from "react";
import { Link } from "react-router-dom";
import type { WalletInfo } from "../api";
import { useT } from "../i18n";
import { walletLifecycle } from "../i18n/strings/walletLifecycle";
import { formatUsdc, ratioMicros, toMicros } from "../money";
import Callout from "./Callout";
import Pill from "./Pill";
import ProgressBar from "./ProgressBar";

type Tone = "green" | "red" | "yellow" | "gray";

/**
 * The three questions that decide whether money can get stuck: will the wallet be open after a
 * restart, is the recovery phrase written down, and is more at risk than a hot wallet should hold.
 * Reads GET /v1/admin/wallet → health; renders nothing against an older server that has none.
 */
export function WalletHealthCard({ wallet }: { wallet: WalletInfo }) {
  const t = useT(walletLifecycle);
  const health = wallet.health;
  if (!health || health.unlock_mode === "none") return null;

  // 1. unlock after a restart
  let unlockTone: Tone;
  let unlockPill: string;
  let unlockText: string;
  if (health.unlock_mode === "manual") {
    [unlockTone, unlockPill, unlockText] = ["yellow", t("pillManual"), t("hManual")];
  } else {
    const legacy = health.unlock_mode === "env_or_file";
    if (health.auto_unlock_ok === false) [unlockTone, unlockPill, unlockText] = ["red", t("pillBroken"), legacy ? t("hEnvBroken") : t("hAutoBroken")];
    else if (health.auto_unlock_ok === true) [unlockTone, unlockPill, unlockText] = ["green", t("pillOk"), legacy ? t("hEnvOk") : t("hAutoOk")];
    else [unlockTone, unlockPill, unlockText] = ["gray", t("pillOk"), legacy ? t("hEnvUntested") : t("hAutoUntested")];
  }

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
        </li>
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

export type WalletBannerKind = "autoBroken" | "backupMissing";

/** Which warnings the Overview shows for this wallet (none in the offline demo, whose wallet holds nothing real). */
export function walletBannerKinds(wallet: WalletInfo | null | undefined, demo = false): WalletBannerKind[] {
  const health = wallet?.health;
  if (!wallet || !health || demo || wallet.simulated) return [];
  const kinds: WalletBannerKind[] = [];
  if (health.auto_unlock_ok === false) kinds.push("autoBroken");
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
