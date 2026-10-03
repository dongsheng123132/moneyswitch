import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import { useAuth } from "../../auth";
import { usePolling } from "../../usePolling";
import { getHistory, HistoryRow } from "../../api";
import { formatUsdc, sumDecimalStrings, toCsv, downloadCsv, urlPath } from "../../money";
import { useDateTime } from "../../i18n/format";
import { useT } from "../../i18n";
import { common } from "../../i18n/strings/common";
import { employeeStrings } from "../../i18n/strings/employee";
import StatusPill from "../../components/StatusPill";
import TxLink from "../../components/TxLink";
import Callout from "../../components/Callout";
import EmptyState from "../../components/EmptyState";
import { SkeletonTable } from "../../components/Skeleton";

const STATUS_FILTERS = ["all", "settled", "reserved", "failed", "unknown"] as const;

export default function EmployeeHistoryPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey as string;
  const { data: history, error, loading } = usePolling(() => getHistory(key));
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const t = useT(employeeStrings);
  const tc = useT(common);
  const dateTime = useDateTime();

  const filtered = useMemo(() => {
    if (!history) return [];
    if (statusFilter === "all") return history;
    return history.filter((h) => h.status === statusFilter);
  }, [history, statusFilter]);

  const total = sumDecimalStrings(filtered.map((h) => h.amount));

  function exportCsv() {
    const headers = [t("csvTime"), t("csvKind"), t("csvTarget"), t("csvAmount"), t("csvStatus"), t("csvTx"), t("csvError")];
    const rows = filtered.map((h) => [
      h.created_at,
      h.kind === "chat" ? tc("kind_chat") : tc("kind_fetch"),
      h.url,
      h.amount,
      tc(`status_${h.status}` as const),
      h.tx_hash ?? "",
      h.error_code ?? "",
    ]);
    downloadCsv(`${t("csvFilePrefix")}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  }

  const hasAnyHistory = (history?.length ?? 0) > 0;

  return (
    <div>
      <div className="toolbar">
        <div className="filters">
          <div className="segmented">
            {STATUS_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className={statusFilter === value ? "active" : ""}
                onClick={() => setStatusFilter(value)}
              >
                {value === "all" ? t("filterAllStatus") : tc(`status_${value}` as const)}
              </button>
            ))}
          </div>
        </div>
        <button className="btn secondary" onClick={exportCsv} disabled={filtered.length === 0}>
          <Download size={14} />
          {t("exportCsv")}
        </button>
      </div>

      {error && <Callout tone="error" title={tc("requestFailed", { message: error })}>{tc("serverUnreachable")}</Callout>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 32 }}>
          <div>
            <div className="stat-label">{t("countLabel")}</div>
            <div className="stat-value num">{filtered.length}</div>
          </div>
          <div>
            <div className="stat-label">{t("totalLabel")}</div>
            <div className="stat-value num">{formatUsdc(total, { maxDecimals: 4 })} {tc("usdc")}</div>
          </div>
        </div>
      </div>

      <div className="card">
        {loading && !history ? (
          <SkeletonTable rows={6} cols={6} />
        ) : filtered.length === 0 ? (
          hasAnyHistory ? (
            <EmptyState
              title={t("emptyFilteredTitle")}
              action={
                <button type="button" className="btn small secondary" onClick={() => setStatusFilter("all")}>
                  {t("clearFilter")}
                </button>
              }
            >
              {t("emptyFilteredBody")}
            </EmptyState>
          ) : (
            <EmptyState
              title={t("emptyNoneTitle")}
              action={
                <Link className="btn small" to="/me/playground">
                  {t("emptyNoneAction")}
                </Link>
              }
            >
              {t("emptyNoneBody")}
            </EmptyState>
          )
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colTime")}</th>
                <th>{t("colKind")}</th>
                <th>{t("colTarget")}</th>
                <th className="num">{t("colAmount")}</th>
                <th>{t("colStatus")}</th>
                <th>{t("colTx")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((h: HistoryRow) => (
                <tr key={h.id} className={h.status === "unknown" ? "row-unknown" : ""}>
                  <td>{dateTime(h.created_at)}</td>
                  <td>
                    <span className="pill pill-blue">{h.kind === "chat" ? tc("kind_chat") : tc("kind_fetch")}</span>
                  </td>
                  <td className="mono" style={{ maxWidth: 260, whiteSpace: "normal", wordBreak: "break-all" }}>
                    {urlPath(h.url) || h.url}
                  </td>
                  <td className="num">{formatUsdc(h.amount, { maxDecimals: 4 })}</td>
                  <td>
                    <StatusPill
                      status={h.status}
                      mock={Boolean(h.tx_hash && h.tx_hash.startsWith("0xmock"))}
                      errorCode={h.error_code}
                    />
                  </td>
                  <td>
                    <TxLink txHash={h.tx_hash} />
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
