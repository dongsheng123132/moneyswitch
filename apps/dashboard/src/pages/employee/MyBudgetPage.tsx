import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth";
import { usePolling } from "../../usePolling";
import { getStatus, getHistory } from "../../api";
import { toMicros, ratioMicros, formatUsdc } from "../../money";
import RingProgress from "../../components/RingProgress";
import Term from "../../components/Term";
import Callout from "../../components/Callout";
import EmptyState from "../../components/EmptyState";
import StatusPill from "../../components/StatusPill";
import { isMockTx } from "../../components/TxLink";
import { SkeletonCard } from "../../components/Skeleton";
import SkillForAi from "../../components/SkillForAi";
import { skillBaseUrl } from "../../skillText";
import { skillStrings } from "../../i18n/strings/skill";
import { useT } from "../../i18n";
import { useRelativeTime } from "../../i18n/format";
import { common } from "../../i18n/strings/common";
import { employeeStrings } from "../../i18n/strings/employee";

async function fetchBudget(key: string) {
  const [status, history] = await Promise.all([getStatus(key), getHistory(key)]);
  return { status, history };
}

/**
 * The holder's own key, ready to hand to an AI: the skill built from the logged-in key (the employee portal's
 * only place for it; sub-keys get theirs when they are created, see MySubKeysPage). Exported for render tests.
 */
export function OwnKeySkillCard({ secret, origin }: { secret: string; origin: string }) {
  const ts = useT(skillStrings);
  return (
    <div className="card connect-section">
      <div className="card-header">
        <h3>{ts("employeeTitle")}</h3>
      </div>
      <div className="connect-section-body">{ts("employeeBody")}</div>
      <SkillForAi baseUrl={skillBaseUrl(null, origin)} secret={secret} showNudge={false} />
    </div>
  );
}

export default function MyBudgetPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey as string;
  const { data, error, loading } = usePolling(() => fetchBudget(key));
  const t = useT(employeeStrings);
  const tc = useT(common);
  const relTime = useRelativeTime();

  if (loading && !data) {
    return (
      <div className="grid">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const status = data?.status;
  const history = (data?.history ?? []).slice(0, 5);

  const hasDaily = status?.daily_budget != null;
  const dailyMicros = hasDaily ? toMicros(status?.daily_budget) : 0n;
  const remainingTodayMicros = toMicros(status?.remaining_today);
  const usedTodayMicros = hasDaily ? dailyMicros - remainingTodayMicros : 0n;
  const todayRatio = hasDaily ? ratioMicros(usedTodayMicros, dailyMicros) : 0;
  const nearLimit = hasDaily && todayRatio >= 0.8 && remainingTodayMicros > 0n;
  const todayExhausted = remainingTodayMicros <= 0n && status != null;

  const hasTotal = status?.total_budget != null;
  const totalMicros = hasTotal ? toMicros(status?.total_budget) : 0n;
  const remainingTotalMicros = toMicros(status?.remaining_total);
  const usedTotalMicros = hasTotal ? totalMicros - remainingTotalMicros : 0n;
  const totalRatio = hasTotal ? ratioMicros(usedTotalMicros, totalMicros) : 0;
  const totalExhausted = remainingTotalMicros <= 0n && status != null;

  return (
    <div>
      {error && (
        <Callout tone="error" title={tc("requestFailed", { message: error })}>
          {tc("serverUnreachable")}
        </Callout>
      )}

      <div className="grid-2">
        <div className="card" style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
          <RingProgress
            ratio={hasDaily ? todayRatio : 0}
            label={
              <div className="stat-value num" style={{ fontSize: 20, lineHeight: 1.2 }}>
                {status ? formatUsdc(status.remaining_today, { maxDecimals: 2 }) : "-"}
              </div>
            }
            sub={
              <div className="stat-sub">
                {hasDaily ? `/ ${formatUsdc(status?.daily_budget, { maxDecimals: 2 })}` : t("todayRemaining")}
              </div>
            }
          />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="stat-label">
              <Term k="dailyBudget">{t("todayRemaining")}</Term>
            </div>
            <div className="stat-value num" style={{ marginBottom: 6 }}>
              {status ? formatUsdc(status.remaining_today, { maxDecimals: 4 }) : "-"} {status?.currency ?? "USDC"}
            </div>

            {todayExhausted && (
              <div style={{ marginBottom: 8 }}>
                <Callout tone="error">{t("errorTodayExhausted")}</Callout>
              </div>
            )}
            {!todayExhausted && nearLimit && (
              <div style={{ marginBottom: 8 }}>
                <Callout tone="warn">{t("warnNearLimit", { pct: Math.round(todayRatio * 100) })}</Callout>
              </div>
            )}

            <div className="stat-label" style={{ marginTop: 14 }}>
              <Term k="perRequestLimit">{t("perRequestLimitLabel")}</Term>
            </div>
            <div className="num">
              {status ? formatUsdc(status.per_request_limit, { maxDecimals: 4 }) : "-"} {status?.currency ?? "USDC"}
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="stat-label">
                <Term k="totalBudget">{t("totalRemaining")}</Term>
              </div>
              {hasTotal ? (
                <>
                  <div className="num" style={{ fontSize: 13, marginBottom: 4 }}>
                    {formatUsdc(status?.remaining_total, { maxDecimals: 4 })} / {formatUsdc(status?.total_budget, { maxDecimals: 4 })}
                  </div>
                  <div className="progress-track">
                    <div
                      className={`progress-fill ${totalRatio >= 1 ? "danger" : totalRatio >= 0.8 ? "warn" : "ok"}`}
                      style={{ width: `${Math.round(totalRatio * 100)}%` }}
                    />
                  </div>
                  {totalExhausted && (
                    <div style={{ marginTop: 8 }}>
                      <Callout tone="error">{t("errorTotalExhausted")}</Callout>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="num">{status ? formatUsdc(status.remaining_total, { maxDecimals: 4 }) : "-"} {status?.currency ?? "USDC"}</div>
                  <div className="field-hint">{t("totalUnavailable")}</div>
                </>
              )}
            </div>

          </div>
        </div>

        <OwnKeySkillCard secret={key} origin={window.location.origin} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3>{t("recentTitle")}</h3>
          {history.length > 0 && (
            <Link className="btn secondary small" to="/me/history">
              {t("viewAllHistory")}
            </Link>
          )}
        </div>
        {history.length === 0 ? (
          <EmptyState
            title={t("emptyHistoryTitle")}
            action={
              <Link className="btn small" to="/me/playground">
                {t("emptyHistoryAction")}
              </Link>
            }
          >
            {t("emptyHistoryBody")}
          </EmptyState>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colTime")}</th>
                <th>{t("colKind")}</th>
                <th>{t("colTarget")}</th>
                <th className="num">{t("colAmount")}</th>
                <th>{t("colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{relTime(h.created_at)}</td>
                  <td>
                    <span className="pill pill-blue">{h.kind === "chat" ? tc("kind_chat") : tc("kind_fetch")}</span>
                  </td>
                  <td className="mono">{h.url}</td>
                  <td className="num">{formatUsdc(h.amount, { maxDecimals: 4 })}</td>
                  <td>
                    <StatusPill status={h.status} mock={isMockTx(h.tx_hash)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
