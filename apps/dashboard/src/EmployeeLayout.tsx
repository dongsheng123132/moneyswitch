import React, { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { CircleDollarSign, MessageSquare, History, Plug, LogOut, GitBranch } from "lucide-react";
import { useAuth } from "./auth";
import { usePolling } from "./usePolling";
import { getStatus, ChatApiError } from "./api";
import { shortAddr } from "./money";
import { useT } from "./i18n";
import { common } from "./i18n/strings/common";
import { employeeStrings } from "./i18n/strings/employee";
import LangSwitch from "./components/LangSwitch";
import Callout from "./components/Callout";
import { useAdminMeta } from "./useAdminMeta";
import "./styles/employee.css";

const NAV = [
  { to: "/me/budget", key: "navBudget" as const, icon: CircleDollarSign },
  { to: "/me/playground", key: "navChat" as const, icon: MessageSquare },
  { to: "/me/history", key: "navHistory" as const, icon: History },
  { to: "/me/connect", key: "navConnect" as const, icon: Plug },
  // SPEC-v0.4.md §A: only shown once we know this key can delegate — until
  // /v1/status answers, status is undefined and the entry stays hidden.
  { to: "/me/children", key: "navChildren" as const, icon: GitBranch, requiresDelegate: true },
];

const KEY_ERROR_CODES = ["KEY_REVOKED", "KEY_EXPIRED", "KEY_INVALID", "KEY_REVOKED_ANCESTOR", "KEY_EXPIRED_ANCESTOR"] as const;
type KeyErrorCode = (typeof KEY_ERROR_CODES)[number];

function isKeyErrorCode(code: string | null): code is KeyErrorCode {
  return code != null && (KEY_ERROR_CODES as readonly string[]).includes(code);
}

export default function EmployeeLayout() {
  const { employeeKey, logout } = useAuth();
  const location = useLocation();
  const t = useT(employeeStrings);
  const tc = useT(common);
  // Employee sessions don't hold an admin token, so this 403s and stays null —
  // the badge below falls back to the testnet label, same as before.
  const meta = useAdminMeta();
  const [keyErrorCode, setKeyErrorCode] = useState<string | null>(null);

  const { data: status } = usePolling(async () => {
    try {
      const res = await getStatus(employeeKey as string);
      setKeyErrorCode(null);
      return res;
    } catch (e) {
      if (e instanceof ChatApiError) {
        // v0.4: distinguish "a key above this sub-key was revoked/expired".
        const ancestor = e.limitScope === "ancestor" && (e.code === "KEY_REVOKED" || e.code === "KEY_EXPIRED");
        setKeyErrorCode(ancestor ? `${e.code}_ANCESTOR` : e.code);
      }
      throw e;
    }
  });

  const current = NAV.find((n) => n.to === location.pathname);
  const title = current ? t(current.key) : "MoneySwitch";
  const keyLabel = status?.key_name || (status?.key_prefix ? `${status.key_prefix}••••` : employeeKey ? `${employeeKey.slice(0, 12)}••••` : "");

  const keyBroken = isKeyErrorCode(keyErrorCode);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">MoneySwitch</div>
            <div className="brand-sub">{t("brandSub")}</div>
          </div>
        </div>
        <nav>
          {NAV.filter((item) => !item.requiresDelegate || status?.can_delegate).map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
                <Icon size={16} strokeWidth={2} />
                <span>{t(item.key)}</span>
              </NavLink>
            );
          })}
        </nav>
        <button className="logout" onClick={logout}>
          <LogOut size={16} strokeWidth={2} />
          <span>{tc("signOut")}</span>
        </button>
      </aside>
      <div className="app-main-col">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <div className="topbar-right">
            <LangSwitch />
            <span className="network-badge">
              <span className="network-dot" />
              {meta?.network_label ?? (meta?.is_mainnet ? tc("networkMainnet") : tc("networkTestnet"))}
            </span>
            <span className="wallet-chip">
              <span className="mono">{keyLabel || shortAddr(employeeKey)}</span>
            </span>
          </div>
        </header>
        <main className="main">
          {keyBroken ? (
            <div className="key-broken-shell">
              <Callout
                tone="error"
                title={t("keyBrokenTitle")}
                action={
                  <button type="button" className="btn secondary" onClick={logout}>
                    {tc("signOut")}
                  </button>
                }
              >
                {t(`keyBroken_${keyErrorCode as KeyErrorCode}`)}
              </Callout>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
