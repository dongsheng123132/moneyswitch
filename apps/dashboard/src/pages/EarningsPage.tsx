import React from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Download } from "lucide-react";
import { usePolling } from "../usePolling";
import { getEarnings, listTollbooths, type EarningsRange, type EarningItem } from "../api";
import { formatUsdc, shortAddr, toCsv, downloadCsv } from "../money";
import EmptyState from "../components/EmptyState";
import Callout from "../components/Callout";
import Pill from "../components/Pill";
import TxLink from "../components/TxLink";
import CopyButton from "../components/CopyButton";
import Term from "../components/Term";
import { ThreeThingsButton } from "../components/ThreeThings";
import { SkeletonTable } from "../components/Skeleton";
import { useT } from "../i18n";
import { earningsStrings } from "../i18n/strings/earnings";
import { common } from "../i18n/strings/common";
import { useDateTime, useRelativeTime } from "../i18n/format";
import "../styles/earnings.css";

const RANGES: EarningsRange[] = ["today", "7d", "all"];

export default function EarningsPage() {
  const t = useT(earningsStrings);
  const tc = useT(common);
  const dateTime = useDateTime();
  const relTime = useRelativeTime();
  const [searchParams, setSearchParams] = useSearchParams();

  const range = (searchParams.get("range") as EarningsRange) ?? "7d";
  const tollboothFilter = searchParams.get("tollbooth") ?? "all";

  const { data: tollbooths } = usePolling(listTollbooths);
  const { data, error, loading } = usePolling(() => getEarnings(range, tollboothFilter === "all" ? undefined : tollboothFilter));

  function updateParam(name: string, value: string, defaultValue: string) {
    const next = new URLSearchParams(searchParams);
    if (value === defaultValue) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  }

  const items: EarningItem[] = data?.items ?? [];

  function exportCsv() {
    const headers = ["time", "tollbooth", "method", "path", "amount", "payer", "tx_hash", "mock", "status", "upstream_status"];
    const rows = items.map((it) => [
      it.created_at,
      it.tollbooth_name,
      it.method,
      it.path,
      it.amount,
      it.payer ?? "",
      it.tx_hash ?? "",
      it.mock ? "true" : "false",
      it.status,
      it.upstream_status ?? "",
    ]);
    downloadCsv(`moneyswitch-earnings-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  }

  return (
    <div>
      <div className="toolbar">
        <div className="filters">
          <div className="segmented">
            {RANGES.map((r) => (
              <button key={r} type="button" className={range === r ? "active" : ""} onClick={() => updateParam("range", r, "7d")}>
                {r === "today" ? t("rangeToday") : r === "7d" ? t("range7d") : t("rangeAll")}
              </button>
            ))}
          </div>
          <select value={tollboothFilter} onChange={(e) => updateParam("tollbooth", e.target.value, "all")}>
            <option value="all">{t("allTollbooths")}</option>
            {(tollbooths ?? []).map((tb) => (
              <option key={tb.id} value={tb.id}>
                {tb.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ThreeThingsButton />
          <button className="btn secondary" onClick={exportCsv} disabled={items.length === 0}>
            <Download size={14} />
            {t("exportCsv")}
          </button>
        </div>
      </div>

      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}

      <div className="grid">
        <div className="kpi-card">
          <div className="stat-label">{t("kpiTotal")}</div>
          <div className="stat-value num">{data ? formatUsdc(data.total, { maxDecimals: 4 }) : "-"} {tc("usdc")}</div>
        </div>
        <div className="kpi-card">
          <div className="stat-label">{t("kpiSettledCount")}</div>
          <div className="stat-value num">{data?.settled_count ?? "-"}</div>
        </div>
        <div className="kpi-card">
          <div className="stat-label">
            <Term k="settleOnlyOnSuccess">{t("kpiFailedCount")}</Term>
          </div>
          <div className="stat-value num">{data?.failed_count ?? "-"}</div>
        </div>
      </div>

      {!loading && data && items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t("emptyTitle")}
            action={
              <Link className="btn small" to="/tollbooths/new">
                {t("emptyAction")}
              </Link>
            }
          >
            {t("emptyBody")}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="grid-2">
            <div className="card">
              <h3>{t("byTollboothTitle")}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t("colName")}</th>
                    <th className="num">{t("colCount")}</th>
                    <th className="num">{t("colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.by_tollbooth ?? []).map((b) => (
                    <tr key={b.tollbooth_id}>
                      <td>{b.name}{b.deleted ? ` (${tc("none")})` : ""}</td>
                      <td className="num">{b.count}</td>
                      <td className="num">{formatUsdc(b.total, { maxDecimals: 4 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <h3>{t("byRouteTitle")}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t("colRoute")}</th>
                    <th className="num">{t("colCount")}</th>
                    <th className="num">{t("colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.by_route ?? []).map((b, i) => (
                    <tr key={i}>
                      <td className="mono">{b.is_default ? t("defaultRoute") : `${b.method} ${b.path_pattern}`}</td>
                      <td className="num">{b.count}</td>
                      <td className="num">{formatUsdc(b.total, { maxDecimals: 4 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card earnings-items-card">
            <h3>{t("itemsTitle")}</h3>
            <p className="muted earnings-items-hint">{t("itemsHint")}</p>
            {loading && !data ? (
              <SkeletonTable rows={6} cols={7} />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t("colTime")}</th>
                    <th>{t("colTollbooth")}</th>
                    <th>{t("colRouteShort")}</th>
                    <th className="num">{t("colAmount")}</th>
                    <th>{t("colPayer")}</th>
                    <th>{t("colTx")}</th>
                    <th>{t("colUpstream")}</th>
                    <th>{t("colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} className={it.status === "failed" ? "row-unknown" : ""}>
                      <td title={dateTime(it.created_at)}>{relTime(it.created_at)}</td>
                      <td>{it.tollbooth_name}</td>
                      <td className="mono">
                        {it.method} {it.path}
                      </td>
                      <td className="num">{formatUsdc(it.amount, { maxDecimals: 4 })}</td>
                      <td>
                        {it.payer ? (
                          <span className="mono" title={it.payer}>
                            {shortAddr(it.payer)}
                            <CopyButton text={it.payer} className="icon-only" />
                          </span>
                        ) : (
                          <span className="dim">-</span>
                        )}
                      </td>
                      <td>
                        <TxLink txHash={it.tx_hash} mock={it.mock} />
                      </td>
                      <td>{it.upstream_status ?? "-"}</td>
                      <td>
                        <Pill tone={it.status === "settled" ? "green" : "red"}>{it.status === "settled" ? t("statusSettled") : t("statusFailed")}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
