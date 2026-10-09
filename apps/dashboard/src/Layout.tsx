import React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { KeyRound, Receipt, ShieldAlert, Wallet, LogOut, CodeXml, MessageSquare, GitPullRequest, ExternalLink } from "lucide-react";
import { useAuth } from "./auth";
import { usePolling } from "./usePolling";
import { listApprovals } from "./api";
import LangSwitch from "./components/LangSwitch";
import NetworkBadge from "./components/NetworkBadge";
import { useT } from "./i18n";
import { shellStrings } from "./i18n/strings/shell";
import { common } from "./i18n/strings/common";
import { useAdminMeta } from "./useAdminMeta";

type NavKey = "nav_wallet" | "nav_keys" | "nav_approvals" | "nav_bills";

/** SPEC.md §2: the dashboard is exactly these four pages (and the login). */
export const NAV: Array<{ to: string; label: NavKey; icon: typeof Wallet }> = [
  { to: "/wallet", label: "nav_wallet", icon: Wallet },
  { to: "/keys", label: "nav_keys", icon: KeyRound },
  { to: "/approvals", label: "nav_approvals", icon: ShieldAlert },
  { to: "/bills", label: "nav_bills", icon: Receipt },
];

export default function Layout() {
  const t = useT(shellStrings);
  const tc = useT(common);
  const meta = useAdminMeta();
  const { logout } = useAuth();
  const location = useLocation();
  const { data: pending } = usePolling(() => listApprovals("pending"), 3000);
  const pendingCount = pending?.length ?? 0;

  const current = NAV.find((n) => location.pathname.startsWith(n.to));
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
              <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
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
        <div className="sidebar-footer">
          <nav aria-label={t("community")}>
            {[
              { label: "github" as const, url: "https://github.com/dongsheng123132/moneyswitch", icon: CodeXml },
              { label: "reportIssue" as const, url: "https://github.com/dongsheng123132/moneyswitch/issues/new/choose", icon: MessageSquare },
              { label: "contributePr" as const, url: "https://github.com/dongsheng123132/moneyswitch/compare?expand=1", icon: GitPullRequest },
            ].map(({ label, url, icon: Icon }) => (
              <a key={label} href={url} target="_blank" rel="noopener noreferrer" title={t("opensNewTab")} data-action-id={`community.${label}`}>
                <Icon size={16} strokeWidth={2} aria-hidden />
                <span>{t(label)}</span>
                <ExternalLink className="community-external" size={12} aria-hidden />
              </a>
            ))}
          </nav>
          <button className="logout" onClick={logout}>
            <LogOut size={16} strokeWidth={2} aria-hidden />
            <span>{tc("signOut")}</span>
          </button>
        </div>
      </aside>
      <div className="app-main-col">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <div className="topbar-right">
            <NetworkBadge meta={meta} />
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
