import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Gauge, MessageSquare, KeyRound, Radio, Activity, ShieldAlert, Wallet, Plug, LogOut } from "lucide-react";
import { useAuth } from "./auth";
import { usePolling } from "./usePolling";
import { getWallet, listApprovals } from "./api";
import { shortAddr, formatUsdc } from "./money";
import CopyButton from "./components/CopyButton";

const NAV = [
  { to: "/", label: "Overview", end: true, icon: Gauge },
  { to: "/playground", label: "Playground", end: false, icon: MessageSquare },
  { to: "/keys", label: "Money Keys", end: false, icon: KeyRound },
  { to: "/channels", label: "Channels", end: false, icon: Radio },
  { to: "/usage", label: "Usage", end: false, icon: Activity },
  { to: "/approvals", label: "Approvals", end: false, icon: ShieldAlert },
  { to: "/wallet", label: "Wallet", end: false, icon: Wallet },
  { to: "/connect", label: "Connect Agent", end: false, icon: Plug },
];

const TITLES: Record<string, string> = {
  "/": "Overview",
  "/playground": "Playground",
  "/keys": "Money Keys",
  "/channels": "Channels",
  "/usage": "Usage",
  "/approvals": "Approvals",
  "/wallet": "Wallet",
  "/connect": "Connect Agent",
};

export default function Layout() {
  const { logout } = useAuth();
  const location = useLocation();
  const { data: wallet, loading: walletLoading } = usePolling(getWallet);
  const { data: pending } = usePolling(() => listApprovals("pending"), 3000);
  const pendingCount = pending?.length ?? 0;

  const title = TITLES[location.pathname] ?? "MoneySwitch";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">MoneySwitch</div>
            <div className="brand-sub">API keys for money</div>
          </div>
        </div>
        <nav>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? "active" : "")}>
                <Icon size={16} strokeWidth={2} />
                <span>{item.label}</span>
                {item.to === "/approvals" && pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
              </NavLink>
            );
          })}
        </nav>
        <button className="logout" onClick={logout}>
          <LogOut size={16} strokeWidth={2} />
          <span>Sign out</span>
        </button>
      </aside>
      <div className="app-main-col">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <div className="topbar-right">
            <span className="network-badge">
              <span className="network-dot" />
              Monad Testnet
            </span>
            {walletLoading && !wallet ? (
              <span className="wallet-chip dim">Loading…</span>
            ) : wallet?.address ? (
              <span className="wallet-chip">
                <span className="mono">{shortAddr(wallet.address)}</span>
                <CopyButton text={wallet.address} className="chip-copy" />
              </span>
            ) : (
              <span className="wallet-chip dim">No wallet</span>
            )}
            <span className="wallet-balance">
              {walletLoading && !wallet ? "…" : wallet?.usdc_balance != null ? `${formatUsdc(wallet.usdc_balance, { maxDecimals: 2 })} USDC` : "-"}
            </span>
          </div>
        </header>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
