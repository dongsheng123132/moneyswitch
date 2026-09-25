import React from "react";
import { AlertTriangle } from "lucide-react";
import { useAuth } from "../../auth";
import { usePolling } from "../../usePolling";
import { getStatus, listModelsForKey, getHistory } from "../../api";
import { toMicros, ratioMicros, formatUsdc, formatRelativeTime } from "../../money";
import RingProgress from "../../components/RingProgress";
import Pill from "../../components/Pill";
import { SkeletonCard } from "../../components/Skeleton";

async function fetchBudget(key: string) {
  const [status, models, history] = await Promise.all([getStatus(key), listModelsForKey(key), getHistory(key)]);
  return { status, models, history };
}

export default function MyBudgetPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey as string;
  const { data, error, loading } = usePolling(() => fetchBudget(key));

  if (loading && !data) {
    return (
      <div className="grid">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const status = data?.status;
  const models = data?.models ?? [];
  const history = (data?.history ?? []).slice(0, 5);

  const hasDaily = status?.daily_budget != null;
  const dailyMicros = hasDaily ? toMicros(status?.daily_budget) : 0n;
  const remainingTodayMicros = toMicros(status?.remaining_today);
  const usedTodayMicros = hasDaily ? dailyMicros - remainingTodayMicros : 0n;
  const todayRatio = hasDaily ? ratioMicros(usedTodayMicros, dailyMicros) : 0;
  const nearLimit = hasDaily && todayRatio >= 0.8;

  const hasTotal = status?.total_budget != null;
  const totalMicros = hasTotal ? toMicros(status?.total_budget) : 0n;
  const remainingTotalMicros = toMicros(status?.remaining_total);
  const usedTotalMicros = hasTotal ? totalMicros - remainingTotalMicros : 0n;
  const totalRatio = hasTotal ? ratioMicros(usedTotalMicros, totalMicros) : 0;

  return (
    <div>
      {error && <div className="error-banner">出错了：{error}</div>}

      <div className="grid-2">
        <div className="card" style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
          {hasDaily ? (
            <RingProgress
              ratio={todayRatio}
              label={
                <div className="stat-value num" style={{ fontSize: 20, lineHeight: 1.2 }}>
                  {formatUsdc(status?.remaining_today, { maxDecimals: 2 })}
                </div>
              }
              sub={<div className="stat-sub">/ {formatUsdc(status?.daily_budget, { maxDecimals: 2 })}</div>}
            />
          ) : (
            <RingProgress
              ratio={0}
              label={
                <div className="stat-value num" style={{ fontSize: 20, lineHeight: 1.2 }}>
                  {status ? formatUsdc(status.remaining_today, { maxDecimals: 2 }) : "-"}
                </div>
              }
              sub={<div className="stat-sub">今日剩余</div>}
            />
          )}
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="stat-label">今日剩余额度</div>
            <div className="stat-value num" style={{ marginBottom: 6 }}>
              {status ? formatUsdc(status.remaining_today, { maxDecimals: 4 }) : "-"} {status?.currency ?? "USDC"}
            </div>
            {nearLimit && (
              <div className="pill pill-yellow" style={{ marginBottom: 8 }}>
                <AlertTriangle size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                接近今日上限，请联系管理员
              </div>
            )}
            <div className="stat-label" style={{ marginTop: 14 }}>
              单笔上限
            </div>
            <div className="num">{status ? formatUsdc(status.per_request_limit, { maxDecimals: 4 }) : "-"} {status?.currency ?? "USDC"}</div>

            {hasTotal ? (
              <div style={{ marginTop: 14 }}>
                <div className="stat-label">总额度剩余</div>
                <div className="num" style={{ fontSize: 13, marginBottom: 4 }}>
                  {formatUsdc(status?.remaining_total, { maxDecimals: 4 })} / {formatUsdc(status?.total_budget, { maxDecimals: 4 })}
                </div>
                <div className="progress-track">
                  <div
                    className={`progress-fill ${totalRatio >= 1 ? "danger" : totalRatio >= 0.8 ? "warn" : "ok"}`}
                    style={{ width: `${Math.round(totalRatio * 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <div className="stat-label">总额度剩余</div>
                <div className="num">{status ? formatUsdc(status.remaining_total, { maxDecimals: 4 }) : "-"} {status?.currency ?? "USDC"}</div>
                <div className="field-hint">总预算信息暂不可用（等后端补充字段）</div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>可用模型</h3>
          </div>
          {models.length === 0 ? (
            <div className="empty-state">暂无可用模型</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {models.map((m) => (
                <span className="pill pill-gray" key={m}>
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h3>最近 5 笔</h3>
        </div>
        {history.length === 0 ? (
          <div className="empty-state">还没有任何消费记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>模型 / 目标</th>
                <th className="num">金额</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{formatRelativeTime(h.created_at)}</td>
                  <td>
                    <Pill tone={h.kind === "chat" ? "blue" : "gray"}>{h.kind === "chat" ? "对话" : "调用"}</Pill>
                  </td>
                  <td className="mono">{h.kind === "chat" ? h.model ?? "-" : h.url}</td>
                  <td className="num">{formatUsdc(h.amount, { maxDecimals: 4 })}</td>
                  <td>
                    <Pill tone={h.status === "settled" ? "green" : h.status === "failed" ? "red" : h.status === "reserved" ? "blue" : "yellow"}>
                      {h.status}
                    </Pill>
                    {h.tx_hash?.startsWith("0xmock") && (
                      <span className="badge mock" style={{ marginLeft: 6 }}>
                        MOCK
                      </span>
                    )}
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
