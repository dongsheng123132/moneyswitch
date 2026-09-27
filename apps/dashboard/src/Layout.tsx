import React from "react";
import { NavLink, Outlet, useLocation, Link } from "react-router-dom";
import { Gauge, MessageSquare, KeyRound, Radio, Activity, ShieldAlert, Wallet, Plug, LogOut, Compass, Lock, TrafficCone, HandCoins } from "lucide-react";
import { useAuth } from "./auth";
import { usePolling } from "./usePolling";
import { getWallet, listApprovals } from "./api";
import { shortAddr, formatUsdc } from "./money";
import CopyButton from "./components/CopyButton";
import LangSwitch from "./components/LangSwitch";
import { useT } from "./i18n";
import { shellStrings } from "./i18n/strings/shell";
import { common } from "./i18n/strings/common";
import { useDemoMode } from "./demoMode";
import { demoStrings } from "./i18n/strings/demo";
import { useAdminMeta } from "./useAdminMeta";
import "./styles/tollbooths.css";

type NavKey =
  | "nav_overview"
  | "nav_playground"
  | "nav_keys"
  | "nav_channels"
  | "nav_usage"
  | "nav_approvals"
  | "nav_wallet"
  | "nav_connect"
  | "nav_tollbooths"
  | "nav_earnings";

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

// SPEC-v0.5 §3: toll booths + earnings, visually grouped under "Get paid" /
// "收款" below the existing items — kept separate from NAV so the group
// label can be rendered once above them.
const RECEIVE_NAV: Array<{ to: string; label: NavKey; end: boolean; icon: typeof Gauge }> = [
  { to: "/tollbooths", label: "nav_tollbooths", end: false, icon: TrafficCone },
  { to: "/earnings", label: "nav_earnings", end: false, icon: HandCoins },
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

  const ALL_NAV = [...NAV, ...RECEIVE_NAV];
  const current = ALL_NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
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
          <div className="sidebar-group-label">{t("nav_group_receive")}</div>
          {RECEIVE_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? "active" : "")}>
                <Icon size={16} strokeWidth={2} aria-hidden />
                <span>{t(item.label)}</span>
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
            {walletLoading && !wallet ? (
              <span className="wallet-chip dim">{t("walletLoading")}</span>
            ) : !wallet?.has_keystore ? (
              <Link className="wallet-chip warn" to="/wallet">
                {t("walletNone")}
              </Link>
            ) : !wallet.unlocked ? (
              <Link className="wallet-chip warn" to="/wallet">
                <Lock size={12} aria-hidden /> {t("walletLocked")}
              </Link>
            ) : wallet.address ? (
              <span className="wallet-chip">
                <span className="mono">{shortAddr(wallet.address)}</span>
                <CopyButton text={wallet.address} className="chip-copy icon-only" />
              </span>
            ) : null}
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
