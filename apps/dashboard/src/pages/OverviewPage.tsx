import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Wallet, TrendingUp, TrendingDown, Minus, KeyRound, Zap, Inbox, CheckCircle2, Circle, ChevronRight, ChevronDown } from "lucide-react";
import { usePolling } from "../usePolling";
import {
  listKeys,
  listUsage,
  listApprovals,
  getWallet,
  isCountedStatus,
  MoneyKeyRow,
  PaymentRow,
  WalletInfo,
  isMockPayment,
} from "../api";
import { sumDecimalStrings, toMicros, fromMicros, ratioMicros, formatUsdc, formatUsd2, isTodayUtc, utcDayKey } from "../money";
import Avatar from "../components/Avatar";
import ProgressBar from "../components/ProgressBar";
import Pill from "../components/Pill";
import BarChart, { BarDatum } from "../components/BarChart";
import { SkeletonCard, SkeletonBlock } from "../components/Skeleton";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import Term from "../components/Term";
import StatusPill from "../components/StatusPill";
import TxLink from "../components/TxLink";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { overviewStrings } from "../i18n/strings/overview";
import { useRelativeTime } from "../i18n/format";
import { WalletBanners, walletBannerKinds } from "../components/WalletHealth";
import "../styles/overview.css";

const SETUP_HIDDEN_KEY = "moneyswitch_setup_hidden";

async function fetchOverview() {
  const [keys, payments, approvals] = await Promise.all([listKeys(), listUsage(), listApprovals("pending")]);
  return { keys, payments, approvals };
}

function yesterdayUtc(now: Date): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function last7DayKeys(now: Date): string[] {
  const keys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

const WEEKDAY_KEYS = ["weekday0", "weekday1", "weekday2", "weekday3", "weekday4", "weekday5", "weekday6"] as const;

export default function OverviewPage() {
  const t = useT(overviewStrings);
  const tc = useT(common);
  const relTime = useRelativeTime();
  const { data, error, loading } = usePolling(fetchOverview);
  const { data: wallet } = usePolling(getWallet);
  const [setupHidden, setSetupHidden] = useState(() => {
    try {
      return localStorage.getItem(SETUP_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });

  // SPEC-v0.4.md §A: "today by agent" aggregates by ROOT key (root rows'
  // used_today already includes their sub-keys' spend server-side — never
  // sum used_today across parent+child rows, that would double-count).
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(() => new Set());
  function toggleExpandedRoot(id: string) {
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function hideSetup() {
    setSetupHidden(true);
    try {
      localStorage.setItem(SETUP_HIDDEN_KEY, "1");
    } catch {
      // ignore
    }
  }

  if (loading && !data) {
    return (
      <div>
        <div className="grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <div className="card">
          <SkeletonBlock height={180} />
        </div>
      </div>
    );
  }

  const keys: MoneyKeyRow[] = data?.keys ?? [];
  const payments: PaymentRow[] = data?.payments ?? [];
  const approvals = data?.approvals ?? [];
  const now = new Date();

  const countedPayments = payments.filter((p) => isCountedStatus(p.status));
  const todayPayments = countedPayments.filter((p) => isTodayUtc(p.created_at, now));
  const yesterdayPayments = countedPayments.filter((p) => isTodayUtc(p.created_at, yesterdayUtc(now)));

  const spentTodayMicros = toMicros(sumDecimalStrings(todayPayments.map((p) => p.amount)));
  const spentYesterdayMicros = toMicros(sumDecimalStrings(yesterdayPayments.map((p) => p.amount)));
  const deltaMicros = spentTodayMicros - spentYesterdayMicros;
  // No spend yesterday means "vs yesterday" has nothing meaningful to compare
  // against — a jump from $0 to anything is not really "+100%". Show a
  // neutral note instead of a (misleadingly red) percentage in that case.
  const hasYesterdayBaseline = spentYesterdayMicros > 0n;
  const deltaTone = !hasYesterdayBaseline ? "flat" : deltaMicros > 0n ? "up" : deltaMicros < 0n ? "down" : "flat";
  const deltaPct = hasYesterdayBaseline ? Math.round((Number(deltaMicros) / Number(spentYesterdayMicros)) * 100) : 0;

  // v0.4: a key disabled by a revoked/expired ancestor is not active either (server-computed status; old servers: enabled).
  const activeKeys = keys.filter((k) => (k.status ? k.status === "active" : k.enabled)).length;

  // 7-day daily spend chart (UTC buckets)
  const dayKeys = last7DayKeys(now);
  const byDay = new Map<string, bigint>();
  for (const dk of dayKeys) byDay.set(dk, 0n);
  for (const p of countedPayments) {
    const dk = utcDayKey(p.created_at);
    if (byDay.has(dk)) byDay.set(dk, (byDay.get(dk) ?? 0n) + toMicros(p.amount));
  }
  const chartData: BarDatum[] = dayKeys.map((dk) => {
    const micros = byDay.get(dk) ?? 0n;
    const d = new Date(dk + "T00:00:00Z");
    return {
      label: t(WEEKDAY_KEYS[d.getUTCDay()]),
      value: Number(micros) / 1e6,
      displayValue: formatUsd2(fromMicros(micros)),
    };
  });

  const recent = [...payments].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 8);

  const keyById = new Map(keys.map((k) => [k.id, k] as const));

  // Root keys only — a root's used_today is already a subtree total (SPEC-v0.4.md §A),
  // so sorting/summing roots never double-counts a child's spend.
  const rootKeys = keys.filter((k) => !k.parent_id);
  const sortedKeys = [...rootKeys].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return toMicros(b.used_today) > toMicros(a.used_today) ? 1 : toMicros(b.used_today) < toMicros(a.used_today) ? -1 : 0;
  });
  const directChildrenOf = new Map<string, MoneyKeyRow[]>();
  for (const k of keys) {
    if (!k.parent_id) continue;
    const list = directChildrenOf.get(k.parent_id);
    if (list) list.push(k);
    else directChildrenOf.set(k.parent_id, [k]);
  }

  // Getting started (A-2): show while setup is incomplete and the user
  // hasn't dismissed the card.
  const hasWallet = Boolean(wallet?.has_keystore);
  const hasKey = keys.length > 0;
  const hasFirstCall = keys.some((k) => Boolean(k.last_used_at));
  const setupIncomplete = !hasWallet || !hasKey;
  const showGettingStarted = setupIncomplete && !setupHidden;

  // Needs attention (D-2): only the callouts that currently apply.
  const pendingCount = approvals.length;
  const walletNotCreated = wallet != null && !wallet.has_keystore;
  const walletLocked = Boolean(wallet?.has_keystore) && wallet?.unlocked === false;
  const balanceZero = Boolean(wallet?.has_keystore) && wallet?.usdc_balance === "0";
  // Backup not confirmed / auto-unlock broken: the two states in which a restart or a lost disk can strand funds.
  const walletWarnings = walletBannerKinds(wallet);
  const hasAttention = pendingCount > 0 || walletNotCreated || walletLocked || balanceZero || walletWarnings.length > 0;

  return (
    <div>
      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}

      {showGettingStarted && (
        <div className="card getting-started-card">
          <div className="card-header">
            <div>
              <h3>{t("gettingStartedTitle")}</h3>
              <div className="card-sub">{t("gettingStartedSub")}</div>
            </div>
            <button className="btn secondary small" onClick={hideSetup}>
              {t("hideSetup")}
            </button>
          </div>
          <div className="getting-started-list">
            {[
              { done: hasWallet, label: t("gettingStartedWallet") },
              { done: hasKey, label: t("gettingStartedKey") },
              { done: hasFirstCall, label: t("gettingStartedCall") },
            ].map((item, i) => (
              <div className="getting-started-item" key={i}>
                {item.done ? <CheckCircle2 size={16} className="gs-check" /> : <Circle size={16} className="gs-empty" />}
                <span className={item.done ? "gs-done" : ""}>{item.label}</span>
              </div>
            ))}
          </div>
          <Link className="btn" to="/setup">
            {t("continueSetup")}
          </Link>
        </div>
      )}

      {hasAttention && (
        <div className="attention-row">
          <WalletBanners wallet={wallet} />
          {pendingCount > 0 && (
            <Callout
              tone="warn"
              action={
                <Link className="btn small secondary" to="/approvals">
                  {t("viewApprovals")}
                </Link>
              }
            >
              {t(pendingCount === 1 ? "attentionPendingApprovals" : "attentionPendingApprovalsPlural", { n: pendingCount })}
            </Callout>
          )}
          {walletNotCreated && (
            <Callout
              tone="warn"
              action={
                <Link className="btn small secondary" to="/setup">
                  {t("setUpWallet")}
                </Link>
              }
            >
              {t("attentionWalletNotCreated")}
            </Callout>
          )}
          {walletLocked && (
            <Callout
              tone="warn"
              action={
                <Link className="btn small secondary" to="/wallet">
                  {t("unlockWallet")}
                </Link>
              }
            >
              <Term k="walletLocked">{t("attentionWalletLocked")}</Term>
            </Callout>
          )}
          {balanceZero && (
            <Callout
              tone="warn"
              action={
                <Link className="btn small secondary" to="/wallet">
                  {t("fundWallet")}
                </Link>
              }
            >
              {t("attentionBalanceZero")}
            </Callout>
          )}
        </div>
      )}

      <div className="grid">
        <div className="kpi-card">
          <div className="kpi-icon">
            <Wallet size={16} />
          </div>
          <div className="stat-label">{t("kpiVaultBalance")}</div>
          <div className="stat-value num">
            {wallet?.usdc_balance != null ? formatUsdc(wallet.usdc_balance, { maxDecimals: 2 }) : "-"}{" "}
            <span style={{ fontSize: 13, color: "var(--text-faint)", fontWeight: 500 }}>{tc("usdc")}</span>
          </div>
          <div className="stat-sub">{wallet?.unlocked ? t("walletUnlockedSub") : wallet?.has_keystore ? t("walletLockedSub") : t("walletNotCreatedSub")}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon">
            <Zap size={16} />
          </div>
          <div className="stat-label">{t("kpiSpentToday")}</div>
          <div className="stat-value num">
            {formatUsdc(sumDecimalStrings(todayPayments.map((p) => p.amount)), { maxDecimals: 2 })}{" "}
            <span style={{ fontSize: 13, color: "var(--text-faint)", fontWeight: 500 }}>{tc("usdc")}</span>
          </div>
          <div className={`stat-delta ${deltaTone}`}>
            {deltaTone === "up" && <TrendingUp size={12} style={{ verticalAlign: -1 }} />}
            {deltaTone === "down" && <TrendingDown size={12} style={{ verticalAlign: -1 }} />}
            {deltaTone === "flat" && <Minus size={12} style={{ verticalAlign: -1 }} />}{" "}
            {!hasYesterdayBaseline
              ? t("noSpendYesterday")
              : deltaTone === "flat"
              ? t("sameAsYesterday")
              : t("vsYesterday", { pct: `${deltaPct > 0 ? "+" : ""}${deltaPct}%` })}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon">
            <KeyRound size={16} />
          </div>
          <div className="stat-label">{t("kpiActiveKeys")}</div>
          <div className="stat-value num">{activeKeys}</div>
          <div className="stat-sub">{t("totalKeysCount", { n: keys.length })}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon">
            <Inbox size={16} />
          </div>
          <div className="stat-label">{t("kpiPaymentsToday")}</div>
          <div className="stat-value num">{todayPayments.length}</div>
          <div className="stat-sub">{t("allTimeCount", { n: payments.length })}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>{t("chartTitle")}</h3>
          <span className="card-sub">{t("utcLabel")}</span>
        </div>
        <BarChart data={chartData} />
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-header">
            <h3>{t("todayByAgentTitle")}</h3>
            <span className="card-sub">{t("keysCount", { n: keys.length })}</span>
          </div>
          {sortedKeys.length === 0 ? (
            <EmptyState
              icon={<KeyRound size={24} />}
              title={t("emptyKeysTitle")}
              action={
                <Link className="btn small" to="/keys?new=1">
                  {t("emptyKeysAction")}
                </Link>
              }
            >
              {t("emptyKeysBody")}
            </EmptyState>
          ) : (
            <div>
              {sortedKeys.map((k) => {
                const usedMicros = toMicros(k.used_today);
                const limitMicros = toMicros(k.daily_budget);
                const remaining = limitMicros - usedMicros;
                const r = ratioMicros(usedMicros, limitMicros);
                const children = directChildrenOf.get(k.id) ?? [];
                const expanded = expandedRoots.has(k.id);
                return (
                  <div key={k.id}>
                    <Link to={`/usage?key=${encodeURIComponent(k.id)}&range=today`} className={`today-agent-row${!k.enabled ? " dimmed" : ""}`}>
                      <div className="today-agent-top">
                        <div className="agent-row">
                          <Avatar name={k.name} />
                          <div>
                            <div className="agent-name">{k.name}</div>
                            <div className="stat-sub" style={{ marginTop: 0 }}>
                              {t("usedOfDaily", { used: formatUsdc(k.used_today, { maxDecimals: 4 }), daily: formatUsdc(k.daily_budget, { maxDecimals: 4 }) })}
                            </div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div className="num" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                            {remaining > 0n ? t("remainingLeft", { amount: formatUsdc(fromMicros(remaining), { maxDecimals: 4 }) }) : t("remainingZero")}
                          </div>
                          {!k.enabled && <Pill tone="red">{t("revokedBadge")}</Pill>}
                        </div>
                      </div>
                      <ProgressBar ratio={r} />
                    </Link>
                    {children.length > 0 && (
                      <button
                        type="button"
                        className="today-agent-toggle"
                        onClick={(e) => {
                          e.preventDefault();
                          toggleExpandedRoot(k.id);
                        }}
                      >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        {expanded ? t("hideSubKeys") : t("showSubKeys", { n: children.length })}
                      </button>
                    )}
                    {expanded &&
                      children.map((child) => {
                        const childUsed = toMicros(child.used_today);
                        const childLimit = toMicros(child.daily_budget);
                        const childR = ratioMicros(childUsed, childLimit);
                        return (
                          <Link
                            key={child.id}
                            to={`/usage?key=${encodeURIComponent(child.id)}&range=today`}
                            className={`today-agent-row today-agent-child${child.status !== "active" ? " dimmed" : ""}`}
                          >
                            <div className="today-agent-top">
                              <div className="agent-row">
                                <Avatar name={child.name} size={20} />
                                <div>
                                  <div className="agent-name">{child.name}</div>
                                  <div className="stat-sub" style={{ marginTop: 0 }}>
                                    {t("usedOfDaily", {
                                      used: formatUsdc(child.used_today, { maxDecimals: 4 }),
                                      daily: formatUsdc(child.daily_budget, { maxDecimals: 4 }),
                                    })}
                                  </div>
                                </div>
                              </div>
                              {child.status !== "active" && <Pill tone="red">{t("revokedBadge")}</Pill>}
                            </div>
                            <ProgressBar ratio={childR} />
                          </Link>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3>{t("recentActivityTitle")}</h3>
          </div>
          {recent.length === 0 ? (
            <EmptyState
              title={t("emptyActivityTitle")}
              action={
                <Link className="btn small" to="/playground">
                  {t("emptyActivityAction")}
                </Link>
              }
            >
              {t("emptyActivityBody")}
            </EmptyState>
          ) : (
            <div className="activity-feed">
              {recent.map((p) => {
                const key = keyById.get(p.key_id);
                const mock = isMockPayment(p);
                const target = p.host;
                return (
                  <div className="activity-item" key={p.id}>
                    <span className={`activity-dot ${mock ? "mock" : p.status === "settled" ? "settled" : p.status === "failed" ? "failed" : "pending"}`} />
                    <div className="activity-body">
                      <Link className="activity-link" to={`/usage?q=${encodeURIComponent(p.tx_hash || p.id)}`}>
                        <div className="activity-title">
                          {t("activitySentence", { agent: key?.name ?? p.key_id.slice(0, 8), amount: formatUsdc(p.amount, { maxDecimals: 4 }), target })}
                        </div>
                        <div className="activity-meta">
                          <StatusPill status={p.status} mock={mock} />
                          <span>{relTime(p.created_at, now)}</span>
                        </div>
                      </Link>
                      <div className="activity-tx">
                        <TxLink txHash={p.tx_hash} mock={mock} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
