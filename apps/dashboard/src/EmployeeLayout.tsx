import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { CircleDollarSign, MessageSquare, History, Plug, LogOut } from "lucide-react";
import { useAuth } from "./auth";
import { usePolling } from "./usePolling";
import { getStatus } from "./api";
import { shortAddr } from "./money";

const NAV = [
  { to: "/me/budget", label: "我的额度", icon: CircleDollarSign },
  { to: "/me/playground", label: "对话", icon: MessageSquare },
  { to: "/me/history", label: "流水", icon: History },
  { to: "/me/connect", label: "接入", icon: Plug },
];

const TITLES: Record<string, string> = {
  "/me/budget": "我的额度",
  "/me/playground": "对话",
  "/me/history": "流水",
  "/me/connect": "接入",
};

export default function EmployeeLayout() {
  const { employeeKey, logout } = useAuth();
  const location = useLocation();
  const { data: status } = usePolling(() => getStatus(employeeKey as string));

  const title = TITLES[location.pathname] ?? "MoneySwitch";
  const keyLabel = status?.key_name || (status?.key_prefix ? `${status.key_prefix}••••` : employeeKey ? `${employeeKey.slice(0, 12)}••••` : "");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">MoneySwitch</div>
            <div className="brand-sub">我的额度</div>
          </div>
        </div>
        <nav>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
                <Icon size={16} strokeWidth={2} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <button className="logout" onClick={logout}>
          <LogOut size={16} strokeWidth={2} />
          <span>退出登录</span>
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
            <span className="wallet-chip">
              <span className="mono">{keyLabel || shortAddr(employeeKey)}</span>
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
