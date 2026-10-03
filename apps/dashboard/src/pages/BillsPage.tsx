import React, { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Search } from "lucide-react";
import { usePolling } from "../usePolling";
import { listBills, listKeys, isMockPayment, type MoneyKeyRow, type PaymentRow } from "../api";
import { formatUsdc, sumDecimalStrings, toCsv, downloadCsv, urlPath, isTodayUtc } from "../money";
import Pill from "../components/Pill";
import TxLink from "../components/TxLink";
import EmptyState from "../components/EmptyState";
import { SkeletonTable } from "../components/Skeleton";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { billsStrings } from "../i18n/strings/bills";
import { useDateTime } from "../i18n/format";
import { useAdminMeta } from "../useAdminMeta";
import "../styles/bills.css";

export type Charged = "yes" | "no" | "maybe";

/**
 * The same three values /v1/fetch answers with (SPEC.md §4): a settled payment is "yes", one that never went out "no", and everything
 * in between (still in flight, or signed with an unknown result) is "maybe".
 */
export function chargedOf(p: Pick<PaymentRow, "status">): Charged {
  return p.status === "settled" ? "yes" : p.status === "failed" ? "no" : "maybe";
}

type RangeFilter = "today" | "24h" | "7d" | "all";
type ChargedFilter = "all" | Charged;

const CHARGED_OPTIONS: ChargedFilter[] = ["all", "yes", "no", "maybe"];
const RANGE_OPTIONS: RangeFilter[] = ["today", "24h", "7d", "all"];
const CHARGED_TONE: Record<Charged, "green" | "gray" | "yellow"> = { yes: "green", no: "gray", maybe: "yellow" };

function withinRange(iso: string, range: RangeFilter, now: number): boolean {
  if (range === "all") return true;
  if (range === "today") return isTodayUtc(iso, new Date(now));
  const ms = range === "24h" ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  return now - new Date(iso).getTime() <= ms;
}

/** One ledger row per payment: time, key, amount, URL, chain, transaction and whether the money left (yes / no / maybe). */
export function BillsTable({
  payments,
  keyNames,
  chainLabels,
  onPickKey,
}: {
  payments: PaymentRow[];
  keyNames: Map<string, string>;
  /** CAIP-2 → display name of the chain. */
  chainLabels: Map<string, string>;
  onPickKey?: (keyId: string) => void;
}) {
  const t = useT(billsStrings);
  const dateTime = useDateTime();
  return (
    <table>
      <thead>
        <tr>
          <th>{t("colTime")}</th>
          <th>{t("colKey")}</th>
          <th className="num">{t("colAmount")}</th>
          <th>{t("colUrl")}</th>
          <th>{t("colChain")}</th>
          <th>{t("colTx")}</th>
          <th>{t("colCharged")}</th>
        </tr>
      </thead>
      <tbody>
        {payments.map((p) => {
          const mock = isMockPayment(p);
          const charged = chargedOf(p);
          const name = keyNames.get(p.key_id);
          return (
            <tr key={p.id} className={charged === "maybe" ? "row-unknown" : ""} data-charged={charged}>
              <td>{dateTime(p.created_at)}</td>
              <td>
                {name ? (
                  <button type="button" className="linklike-btn" onClick={() => onPickKey?.(p.key_id)}>
                    {name}
                  </button>
                ) : (
                  <span className="mono">{p.key_id.slice(0, 8)}</span>
                )}
              </td>
              <td className="num">{formatUsdc(p.amount, { maxDecimals: 4 })}</td>
              <td className="mono bills-url">{`${p.host}${urlPath(p.url)}`}</td>
              <td>{chainLabels.get(p.network) ?? p.network}</td>
              <td>
                <TxLink txHash={p.tx_hash} mock={mock} network={p.network} />
              </td>
              <td>
                <span title={t(charged === "yes" ? "chargedYesHint" : charged === "no" ? "chargedNoHint" : "chargedMaybeHint")}>
                  <Pill tone={CHARGED_TONE[charged]}>{t(charged === "yes" ? "chargedYes" : charged === "no" ? "chargedNo" : "chargedMaybe")}</Pill>
                </span>
                {p.error_code && charged !== "yes" && <span className="bills-error-code">{p.error_code}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function BillsPage() {
  const t = useT(billsStrings);
  const tc = useT(common);
  const meta = useAdminMeta();
  const { data: payments, error, loading } = usePolling(listBills);
  const { data: keys } = usePolling(listKeys);
  const [searchParams, setSearchParams] = useSearchParams();

  const keyFilter = searchParams.get("key") ?? "all";
  const chargedFilter = (searchParams.get("charged") as ChargedFilter) ?? "all";
  const range = (searchParams.get("range") as RangeFilter) ?? "7d";
  const q = searchParams.get("q") ?? "";

  function updateParam(name: string, value: string, defaultValue: string) {
    const next = new URLSearchParams(searchParams);
    if (value === defaultValue) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  }

  const keyNames = useMemo(() => new Map((keys ?? []).map((k: MoneyKeyRow) => [k.id, k.name] as const)), [keys]);
  const chainLabels = useMemo(() => new Map((meta?.networks ?? []).map((n) => [n.network, n.network_label] as const)), [meta]);

  const filtered = useMemo(() => {
    if (!payments) return [];
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    return payments.filter((p) => {
      if (keyFilter !== "all" && p.key_id !== keyFilter) return false;
      if (chargedFilter !== "all" && chargedOf(p) !== chargedFilter) return false;
      if (!withinRange(p.created_at, range, now)) return false;
      if (needle) {
        const haystack = [p.tx_hash, p.url, p.host, p.id].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [payments, keyFilter, chargedFilter, range, q]);

  const totalAmount = sumDecimalStrings(filtered.filter((p) => chargedOf(p) !== "no").map((p) => p.amount));
  const maybeCount = filtered.filter((p) => chargedOf(p) === "maybe").length;
  const hasActiveFilters = keyFilter !== "all" || chargedFilter !== "all" || range !== "7d" || q !== "";

  function clearFilters() {
    setSearchParams({}, { replace: true });
  }

  function exportCsv() {
    const headers = ["time", "key_id", "key_name", "host", "url", "network", "amount", "charged", "tx_hash", "error_code"];
    const rows = filtered.map((p) => [
      p.created_at,
      p.key_id,
      keyNames.get(p.key_id) ?? "",
      p.host,
      p.url,
      p.network,
      p.amount,
      chargedOf(p),
      p.tx_hash ?? "",
      p.error_code ?? "",
    ]);
    downloadCsv(`moneyswitch-bills-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  }

  return (
    <div>
      <div className="toolbar">
        <div className="filters">
          <select value={keyFilter} onChange={(e) => updateParam("key", e.target.value, "all")}>
            <option value="all">{t("allKeys")}</option>
            {(keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label={t("colCharged")}>
            {CHARGED_OPTIONS.map((opt) => (
              <button key={opt} type="button" className={chargedFilter === opt ? "active" : ""} onClick={() => updateParam("charged", opt, "all")}>
                {opt === "all" ? t("chargedAny") : t(opt === "yes" ? "chargedYes" : opt === "no" ? "chargedNo" : "chargedMaybe")}
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
            <input type="text" value={q} placeholder={t("searchPlaceholder")} onChange={(e) => updateParam("q", e.target.value, "")} />
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
            <div className="stat-label">{t("summaryMaybe")}</div>
            <div className="stat-value num">{maybeCount}</div>
          </div>
        </div>
      </div>

      <div className="card">
        {loading && !payments ? (
          <SkeletonTable rows={6} cols={7} />
        ) : !payments || payments.length === 0 ? (
          <EmptyState
            title={t("emptyNoPaymentsTitle")}
            action={
              <Link className="btn small" to="/keys">
                {t("emptyNoPaymentsAction")}
              </Link>
            }
          >
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
          <BillsTable payments={filtered} keyNames={keyNames} chainLabels={chainLabels} onPickKey={(id) => updateParam("key", id, "all")} />
        )}
      </div>
    </div>
  );
}
