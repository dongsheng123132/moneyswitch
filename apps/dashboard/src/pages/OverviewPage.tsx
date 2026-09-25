import React from "react";
import { Wallet, TrendingUp, TrendingDown, Minus, KeyRound, Zap, Inbox } from "lucide-react";
import { usePolling } from "../usePolling";
import { listKeys, listUsage, getWallet, isCountedStatus, MoneyKeyRow, PaymentRow, WalletInfo, isMockPayment } from "../api";
import { sumMicros, sumDecimalStrings, toMicros, fromMicros, ratioMicros, formatUsdc, formatUsd2, isTodayUtc, utcDayKey, formatRelativeTime } from "../money";
import Avatar from "../components/Avatar";
import ProgressBar from "../components/ProgressBar";
import Pill from "../components/Pill";
import BarChart, { BarDatum } from "../components/BarChart";
import { SkeletonCard, SkeletonBlock } from "../components/Skeleton";

async function fetchOverview() {
  const [keys, payments, wallet] = await Promise.all([listKeys(), listUsage(), getWallet()]);
  return { keys, payments, wallet };
}

function yesterdayUtc(now: Date): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function last7DayKeys(now: Date): string[] {
  const keys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

function statusDotClass(p: PaymentRow): string {
  if (isMockPayment(p)) return "mock";
  if (p.status === "settled") return "settled";
  if (p.status === "failed") return "failed";
  return "pending";
}

export default function OverviewPage() {
  const { data, error, loading } = usePolling(fetchOverview);

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
  const wallet: WalletInfo | undefined = data?.wallet;
  const now = new Date();

  const countedPayments = payments.filter((p) => isCountedStatus(p.status));
  const todayPayments = countedPayments.filter((p) => isTodayUtc(p.created_at, now));
  const yesterdayPayments = countedPayments.filter((p) => isTodayUtc(p.created_at, yesterdayUtc(now)));

  const spentTodayMicros = sumMicros(todayPayments.map((p) => p.amount));
  const spentYesterdayMicros = sumMicros(yesterdayPayments.map((p) => p.amount));
  const deltaMicros = spentTodayMicros - spentYesterdayMicros;
  // No spend yesterday means "vs yesterday" has nothing meaningful to compare
  // against — a jump from $0 to anything is not really "+100%". Show a
  // neutral note instead of a (misleadingly red) percentage in that case.
  const hasYesterdayBaseline = spentYesterdayMicros > 0n;
  const deltaTone = !hasYesterdayBaseline ? "flat" : deltaMicros > 0n ? "up" : deltaMicros < 0n ? "down" : "flat";
  const deltaPct = hasYesterdayBaseline ? Math.round((Number(deltaMicros) / Number(spentYesterdayMicros)) * 100) : 0;

  const activeKeys = keys.filter((k) => k.enabled).length;

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
      label: DAY_LABELS[d.getUTCDay()],
      value: Number(micros) / 1e6,
      displayValue: formatUsd2(fromMicros(micros)),
    };
  });

  const recent = [...payments]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 8);

  const keyById = new Map(keys.map((k) => [k.id, k] as const));

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="grid">
        <div className="kpi-card">
          <div className="kpi-icon">
            <Wallet size={16} />
          </div>
          <div className="stat-label">Vault balance</div>
          <div className="stat-value num">{wallet?.usdc_balance != null ? formatUsdc(wallet.usdc_balance, { maxDecimals: 2 }) : "-"} <span style={{ fontSize: 13, color: "var(--text-faint)", fontWeight: 500 }}>USDC</span></div>
          <div className="stat-sub">{wallet?.unlocked ? "Unlocked" : wallet?.has_keystore ? "Locked" : "Not created"}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon">
            <Zap size={16} />
          </div>
          <div className="stat-label">Spent today</div>
          <div className="stat-value num">{formatUsdc(sumDecimalStrings(todayPayments.map((p) => p.amount)), { maxDecimals: 2 })} <span style={{ fontSize: 13, color: "var(--text-faint)", fontWeight: 500 }}>USDC</span></div>
          <div className={`stat-delta ${deltaTone}`}>
            {deltaTone === "up" && <TrendingUp size={12} style={{ verticalAlign: -1 }} />}
            {deltaTone === "down" && <TrendingDown size={12} style={{ verticalAlign: -1 }} />}
            {deltaTone === "flat" && <Minus size={12} style={{ verticalAlign: -1 }} />}
            {" "}
            {!hasYesterdayBaseline
              ? "No spend yesterday"
              : deltaTone === "flat"
              ? "same as yesterday"
              : `${deltaPct > 0 ? "+" : ""}${deltaPct}% vs yesterday`}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon">
            <KeyRound size={16} />
          </div>
          <div className="stat-label">Active keys</div>
          <div className="stat-value num">{activeKeys}</div>
          <div className="stat-sub">{keys.length} total</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon">
            <Inbox size={16} />
          </div>
          <div className="stat-label">Payments today</div>
          <div className="stat-value num">{todayPayments.length}</div>
          <div className="stat-sub">{payments.length} all time</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Daily spend — last 7 days</h3>
          <span className="card-sub">UTC</span>
        </div>
        <BarChart data={chartData} />
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-header">
            <h3>Agents</h3>
            <span className="card-sub">{keys.length} keys</span>
          </div>
          {keys.length === 0 ? (
            <div className="empty-state">No MoneyKeys yet.</div>
          ) : (
            <div>
              {keys.map((k) => {
                const usedMicros = toMicros(k.used_today);
                const limitMicros = toMicros(k.daily_budget);
                const remaining = limitMicros - usedMicros;
                const r = ratioMicros(usedMicros, limitMicros);
                return (
                  <div key={k.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--panel-border-soft)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <div className="agent-row">
                        <Avatar name={k.name} />
                        <div>
                          <div className="agent-name">{k.name}</div>
                          <div className="stat-sub" style={{ marginTop: 0 }}>
                            {formatUsdc(k.used_today, { maxDecimals: 4 })} / {formatUsdc(k.daily_budget, { maxDecimals: 4 })} USDC today
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div className="num" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                          {remaining > 0n ? `${formatUsdc(fromMicros(remaining), { maxDecimals: 4 })} left` : "0 left"}
                        </div>
                        {!k.enabled && <Pill tone="red">revoked</Pill>}
                      </div>
                    </div>
                    <ProgressBar ratio={r} />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Recent activity</h3>
          </div>
          {recent.length === 0 ? (
            <div className="empty-state">No activity yet.</div>
          ) : (
            <div className="activity-feed">
              {recent.map((p) => {
                const key = keyById.get(p.key_id);
                const mock = isMockPayment(p);
                return (
                  <div className="activity-item" key={p.id}>
                    <span className={`activity-dot ${statusDotClass(p)}`} />
                    <div className="activity-body">
                      <div className="activity-title">
                        {key?.name ?? p.key_id.slice(0, 8)} paid <span className="num">{formatUsdc(p.amount, { maxDecimals: 4 })}</span> USDC to{" "}
                        {p.kind === "chat" && p.model ? p.model : p.host}
                        {mock && <span className="badge mock" style={{ marginLeft: 6 }}>MOCK</span>}
                      </div>
                      <div className="activity-meta">
                        <Pill tone={p.status === "settled" ? "green" : p.status === "failed" ? "red" : "yellow"}>{p.status}</Pill>
                        <span>{formatRelativeTime(p.created_at, now)}</span>
                        {p.tx_hash && !mock && (
                          <a href={`https://testnet.monadvision.com/tx/${p.tx_hash}`} target="_blank" rel="noreferrer">
                            tx
                          </a>
                        )}
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
