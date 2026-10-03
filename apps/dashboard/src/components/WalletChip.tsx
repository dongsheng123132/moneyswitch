import React from "react";
import { Link } from "react-router-dom";
import { Lock, ShieldAlert } from "lucide-react";
import type { WalletInfo } from "../api";
import { useT } from "../i18n";
import { shellStrings } from "../i18n/strings/shell";
import { walletLifecycle } from "../i18n/strings/walletLifecycle";
import { shortAddr } from "../money";
import CopyButton from "./CopyButton";

/**
 * The wallet chip in the top bar, on every page.
 *
 * Until the recovery phrase is written down and checked, the wallet's address is shown nowhere (no chip text, no Copy
 * button, no QR code): nobody should send money to a wallet that has no backup. The chip then points at the backup instead.
 */
export function WalletChip({ wallet, loading }: { wallet: WalletInfo | null | undefined; loading: boolean }) {
  const t = useT(shellStrings);
  const tl = useT(walletLifecycle);
  if (loading && !wallet) return <span className="wallet-chip dim">{t("walletLoading")}</span>;
  if (!wallet?.has_keystore) {
    return (
      <Link className="wallet-chip warn" to="/wallet">
        {t("walletNone")}
      </Link>
    );
  }
  if (!wallet.unlocked) {
    return (
      <Link className="wallet-chip warn" to="/wallet">
        <Lock size={12} aria-hidden /> {t("walletLocked")}
      </Link>
    );
  }
  if (wallet.health?.backup === "missing") {
    return (
      <Link className="wallet-chip warn" to="/wallet" data-testid="wallet-chip-backup">
        <ShieldAlert size={12} aria-hidden /> {tl("chipBackupFirst")}
      </Link>
    );
  }
  if (!wallet.address) return null;
  return (
    <span className="wallet-chip">
      <span className="mono">{shortAddr(wallet.address)}</span>
      <CopyButton text={wallet.address} className="chip-copy icon-only" />
    </span>
  );
}
