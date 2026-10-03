import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Gauge, MessageSquare, KeyRound, Radio, Activity, ShieldAlert, Wallet, Plug, LogOut, Compass } from "lucide-react";
import { useAuth } from "./auth";
import { usePolling } from "./usePolling";
import { getWallet, listApprovals } from "./api";
import { formatUsdc } from "./money";
import LangSwitch from "./components/LangSwitch";
import { WalletChip } from "./components/WalletChip";
import { useT } from "./i18n";
import { shellStrings } from "./i18n/strings/shell";
import { common } from "./i18n/strings/common";
import { useDemoMode } from "./demoMode";
import { demoStrings } from "./i18n/strings/demo";
import { useAdminMeta } from "./useAdminMeta";

type NavKey =
  | "nav_overview"
  | "nav_playground"
  | "nav_keys"
  | "nav_channels"
  | "nav_usage"
  | "nav_approvals"
  | "nav_wallet"
  | "nav_connect";

const NAV: Array<{ to: string; label: NavKey; end: boolean; icon: typeof Gauge }> = [
  { to: "/", label: "nav_overview", end: true, icon: Gauge },
  { to: "/playground", label: "nav_playground", end: false, icon: MessageSquare },
  { to: "/keys", label: "nav_keys", end: false, icon: KeyRound },
  { to: "/channels", label: "nav_channels", end: false, icon: Radio },
  { to: "/usage", label: "nav_usage", end: false, icon: Activity },
  { to: "/approvals", label: "nav_approvals", end: false, icon: ShieldAlert },
  { to: "/wallet", label: "nav_wallet", end: false, icon: Wallet },
  { to: "/connect", label: "nav_connect", end: false, icon: Plug },
];


export default function Layout() {
  const t = useT(shellStrings);
  const tc = useT(common);
  const td = useT(demoStrings);
  const demo = useDemoMode();
  const meta = useAdminMeta();
  const { logout } = useAuth();
  const location = useLocation();
  const { data: wallet, loading: walletLoading } = usePolling(getWallet);
  const { data: pending } = usePolling(() => listApprovals("pending"), 3000);
  const pendingCount = pending?.length ?? 0;

  const current = NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
  const title = current ? t(current.label) : "MoneySwitch";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {t("skipToContent")}
      </a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">MoneySwitch</div>
            <div className="brand-sub">{t("brandSub")}</div>
          </div>
        </div>
        <nav>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? "active" : "")}>
                <Icon size={16} strokeWidth={2} aria-hidden />
                <span>{t(item.label)}</span>
                {item.to === "/approvals" && pendingCount > 0 && (
                  <span className="nav-badge" aria-label={`${pendingCount}`}>
                    {pendingCount}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
        <NavLink to="/setup" className={({ isActive }) => `sidebar-secondary ${isActive ? "active" : ""}`}>
          <Compass size={16} strokeWidth={2} aria-hidden />
          <span>{t("nav_setup")}</span>
        </NavLink>
        <button className="logout" onClick={logout}>
          <LogOut size={16} strokeWidth={2} aria-hidden />
          <span>{tc("signOut")}</span>
        </button>
      </aside>
      <div className="app-main-col">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <div className="topbar-right">
            <span className={`network-badge${demo ? " demo" : ""}`}>
              <span className="network-dot" />
              {demo ? td("networkBadge") : meta?.network_label ?? (meta?.is_mainnet ? tc("networkMainnet") : tc("networkTestnet"))}
            </span>
            <WalletChip wallet={wallet} loading={walletLoading} />
            {wallet?.has_keystore && (
              <span className="wallet-balance" title={wallet.usdc_balance == null ? t("walletBalanceUnknown") : undefined}>
                {wallet.usdc_balance != null ? `${formatUsdc(wallet.usdc_balance, { maxDecimals: 2 })} USDC` : "—"}
              </span>
            )}
            <LangSwitch />
          </div>
        </header>
        <main className="main" id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
