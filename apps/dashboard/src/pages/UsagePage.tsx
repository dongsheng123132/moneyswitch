import React, { useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Download, Search } from "lucide-react";
import { usePolling } from "../usePolling";
import { listUsage, listKeys, isMockPayment, PaymentRow } from "../api";
import { formatUsdc, sumDecimalStrings, toCsv, downloadCsv, urlPath, isTodayUtc } from "../money";
import Pill from "../components/Pill";
import StatusPill from "../components/StatusPill";
import TxLink from "../components/TxLink";
import EmptyState from "../components/EmptyState";
import Term from "../components/Term";
import { SkeletonTable } from "../components/Skeleton";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { usageStrings } from "../i18n/strings/usage";
import { useDateTime } from "../i18n/format";
import "../styles/usage.css";

type RangeFilter = "today" | "24h" | "7d" | "all";
type StatusFilter = "all" | "settled" | "reserved" | "failed" | "unknown";

const STATUS_OPTIONS: StatusFilter[] = ["all", "settled", "reserved", "failed", "unknown"];
const RANGE_OPTIONS: RangeFilter[] = ["today", "24h", "7d", "all"];

function withinRange(iso: string, range: RangeFilter, now: number): boolean {
  if (range === "all") return true;
  if (range === "today") return isTodayUtc(iso, new Date(now));
  const ms = range === "24h" ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  return now - new Date(iso).getTime() <= ms;
}

export default function UsagePage() {
  const t = useT(usageStrings);
  const tc = useT(common);
  const dateTime = useDateTime();
  const { data: payments, error, loading } = usePolling(listUsage);
  const { data: keys } = usePolling(listKeys);
  const [searchParams, setSearchParams] = useSearchParams();

  const keyFilter = searchParams.get("key") ?? "all";
  const statusFilter = (searchParams.get("status") as StatusFilter) ?? "all";
  const range = (searchParams.get("range") as RangeFilter) ?? "7d";
  const q = searchParams.get("q") ?? "";

  function updateParam(name: string, value: string, defaultValue: string) {
    const next = new URLSearchParams(searchParams);
    if (value === defaultValue) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  }

  const keyById = useMemo(() => new Map((keys ?? []).map((k) => [k.id, k] as const)), [keys]);

  const filtered = useMemo(() => {
    if (!payments) return [];
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    return payments.filter((p) => {
      if (keyFilter !== "all" && p.key_id !== keyFilter) return false;
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!withinRange(p.created_at, range, now)) return false;
      if (needle) {
        const haystack = [p.tx_hash, p.url, p.host, p.model, p.id].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [payments, keyFilter, statusFilter, range, q]);

  const totalAmount = sumDecimalStrings(filtered.map((p) => p.amount));
  const needsReviewCount = filtered.filter((p) => p.status === "unknown").length;
  const hasActiveFilters = keyFilter !== "all" || statusFilter !== "all" || range !== "7d" || q !== "";

  function clearFilters() {
    setSearchParams({}, { replace: true });
  }

  function exportCsv() {
    const headers = ["time", "key_id", "key_name", "type", "model", "host", "method", "amount", "status", "tokens", "mock", "tx_hash", "error_code"];
    const rows = filtered.map((p) => [
      p.created_at,
      p.key_id,
      keyById.get(p.key_id)?.name ?? "",
      p.kind ?? "fetch",
      p.model ?? "",
      p.host,
      p.method,
      p.amount,
      p.status,
      (p.prompt_tokens ?? 0) + (p.completion_tokens ?? 0) || "",
      isMockPayment(p) ? "true" : "false",
      p.tx_hash ?? "",
      p.error_code ?? "",
    ]);
    downloadCsv(`moneyswitch-usage-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  }

  return (
    <div>
      <div className="toolbar">
        <div className="filters">
          <select value={keyFilter} onChange={(e) => updateParam("key", e.target.value, "all")}>
            <option value="all">{t("allAgents")}</option>
            {(keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <div className="segmented">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                className={statusFilter === opt ? "active" : ""}
                onClick={() => updateParam("status", opt, "all")}
              >
                {opt === "all" ? tc("all") : tc(`status_${opt}` as const)}
              </button>
            ))}
          </div>
          <select value={range} onChange={(e) => updateParam("range", e.target.value, "7d")}>
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {t(opt === "today" ? "rangeToday" : opt === "24h" ? "range24h" : opt === "7d" ? "range7d" : "rangeAll")}
              </option>
            ))}
          </select>
          <label className="search-input">
            <Search size={13} aria-hidden />
            <input
              type="text"
              value={q}
              placeholder={t("searchPlaceholder")}
              onChange={(e) => updateParam("q", e.target.value, "")}
            />
          </label>
          {hasActiveFilters && (
            <button type="button" className="btn secondary small" onClick={clearFilters}>
              {t("clearFilters")}
            </button>
          )}
        </div>
        <button className="btn secondary" onClick={exportCsv} disabled={filtered.length === 0}>
          <Download size={14} />
          {t("exportCsv")}
        </button>
      </div>

      {error && <div className="error-banner">{tc("requestFailed", { message: error })}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 32 }}>
          <div>
            <div className="stat-label">{t("summaryCount")}</div>
            <div className="stat-value num">{filtered.length}</div>
          </div>
          <div>
            <div className="stat-label">{t("summaryTotal")}</div>
            <div className="stat-value num">
              {formatUsdc(totalAmount, { maxDecimals: 4 })} {tc("usdc")}
            </div>
          </div>
          <div>
            <div className="stat-label">
              <Term k="status_unknown">{t("summaryNeedsReview")}</Term>
            </div>
            <div className="stat-value num">{needsReviewCount}</div>
          </div>
        </div>
      </div>

      <div className="card">
        {loading && !payments ? (
          <SkeletonTable rows={6} cols={8} />
        ) : !payments || payments.length === 0 ? (
          <EmptyState title={t("emptyNoPaymentsTitle")} action={<Link className="btn small" to="/playground">{t("emptyNoPaymentsAction")}</Link>}>
            {t("emptyNoPaymentsBody")}
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={t("emptyFilteredTitle")}
            action={
              <button type="button" className="btn small secondary" onClick={clearFilters}>
                {t("clearFilters")}
              </button>
            }
          >
            {t("emptyFilteredBody")}
          </EmptyState>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colTime")}</th>
                <th>{t("colAgent")}</th>
                <th>{t("colType")}</th>
                <th>{t("colTarget")}</th>
                <th className="num">{t("colAmount")}</th>
                <th className="num">{t("colTokens")}</th>
                <th>{t("colStatus")}</th>
                <th>{t("colTx")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p: PaymentRow) => {
                const mock = isMockPayment(p);
                const target = p.kind === "chat" ? p.model ?? "-" : `${p.host}${urlPath(p.url)}`;
                return (
                  <tr key={p.id} className={p.status === "unknown" ? "row-unknown" : ""}>
                    <td>{dateTime(p.created_at)}</td>
                    <td>
                      {keyById.get(p.key_id) ? (
                        <button type="button" className="linklike-btn" onClick={() => updateParam("key", p.key_id, "all")}>
                          {keyById.get(p.key_id)?.name}
                        </button>
                      ) : (
                        <span className="mono">{p.key_id.slice(0, 8)}</span>
                      )}
                    </td>
                    <td>
                      <Pill tone={p.kind === "chat" ? "blue" : "gray"}>{tc(p.kind === "chat" ? "kind_chat" : "kind_fetch")}</Pill>
                    </td>
                    <td className="mono" style={{ maxWidth: 260, whiteSpace: "normal", wordBreak: "break-all" }}>
                      {target}
                    </td>
                    <td className="num">{formatUsdc(p.amount, { maxDecimals: 4 })}</td>
                    <td className="num">
                      {p.prompt_tokens != null || p.completion_tokens != null ? (p.prompt_tokens ?? 0) + (p.completion_tokens ?? 0) : "-"}
                    </td>
                    <td>
                      <StatusPill status={p.status} mock={mock} />
                    </td>
                    <td>
                      <TxLink txHash={p.tx_hash} mock={mock} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
