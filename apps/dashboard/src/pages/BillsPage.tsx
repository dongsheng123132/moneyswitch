import React, { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowUpRight, ChevronDown, Clock3, Download, LockKeyhole, Search, ShieldCheck } from "lucide-react";
import { usePolling } from "../usePolling";
import { listBills, listKeys, isMockPayment, type BillsList, type MoneyKeyRow, type NetworkMode, type PaymentRow } from "../api";
import { formatUsdc, sumDecimalStrings, toCsv, downloadCsv, isTodayUtc } from "../money";
import NetworkKindPill from "../components/NetworkKindPill";
import Callout from "../components/Callout";
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
type KindFilter = "all" | NetworkMode;

const CHARGED_OPTIONS: ChargedFilter[] = ["all", "maybe", "yes", "no"];
const RANGE_OPTIONS: RangeFilter[] = ["today", "24h", "7d", "all"];
const KIND_OPTIONS: KindFilter[] = ["all", "mainnet", "testnet"];

/** Mainnet money and testnet tokens are never added together (SPEC.md §2); a chain the server does not know is a bucket of its own, never folded into either. */
export type BillsBucket = NetworkMode | "other";

export function bucketOf(p: Pick<PaymentRow, "network_kind">): BillsBucket {
  return p.network_kind === "mainnet" || p.network_kind === "testnet" ? p.network_kind : "other";
}

const BUCKET_ORDER: BillsBucket[] = ["mainnet", "testnet", "other"];

function totalsByCharge(payments: PaymentRow[], charged: Charged): Array<{ kind: BillsBucket; total: string }> {
  return BUCKET_ORDER.filter((kind) => payments.some((p) => bucketOf(p) === kind)).map((kind) => ({
    kind,
    total: sumDecimalStrings(payments.filter((p) => bucketOf(p) === kind && chargedOf(p) === charged).map((p) => p.amount)),
  }));
}

/** Only confirmed payments belong to the paid total; mainnet money and test tokens remain separate. */
export function billsTotalsByKind(payments: PaymentRow[]): Array<{ kind: BillsBucket; total: string }> {
  return totalsByCharge(payments, "yes");
}

/** Unknown and reserved payments are a separate amount to check, never an asserted expense. */
export function billsPendingTotalsByKind(payments: PaymentRow[]): Array<{ kind: BillsBucket; total: string }> {
  return totalsByCharge(payments.filter((p) => chargedOf(p) === "maybe"), "maybe");
}

/** The Network type filter: every payment, or only those on mainnets, or only those on testnets. */
export function kindMatches(p: Pick<PaymentRow, "network_kind">, filter: KindFilter): boolean {
  return filter === "all" || bucketOf(p) === filter;
}

function withinRange(iso: string, range: RangeFilter, now: number): boolean {
  if (range === "all") return true;
  if (range === "today") return isTodayUtc(iso, new Date(now));
  const ms = range === "24h" ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  return now - new Date(iso).getTime() <= ms;
}

/** A key is an attribution label, not a verified agent identity (keys can be shared). */
export function billKeyName(p: Pick<PaymentRow, "key_id" | "key_name">, keyNames: Map<string, string>): string {
  return p.key_name || keyNames.get(p.key_id) || p.key_id.slice(0, 8);
}

/** Audit details are mounted only after an explicit request, so a collapsed row has no private URL or purpose in its DOM. */
export function BillsPaymentDetails({ payment: p, keyName, chainLabel, showPurpose = false }: {
  payment: PaymentRow;
  keyName: string;
  chainLabel: string;
  showPurpose?: boolean;
}) {
  const t = useT(billsStrings);
  const dateTime = useDateTime();
  return (
    <dl className="bills-details" data-testid="bill-details">
      <div><dt>{t("colTime")}</dt><dd><time dateTime={p.created_at}>{dateTime(p.created_at)}</time></dd></div>
      <div><dt>{t("colKey")}</dt><dd>{keyName} <span className="mono dim">({p.key_id})</span></dd></div>
      <div><dt>{t("colPurpose")}</dt><dd>{!p.purpose ? t("purposeMissing") : showPurpose ? p.purpose : t("purposeHidden")}</dd></div>
      <div><dt>{t("fullRequest")}</dt><dd className="mono">{p.method} {p.url}</dd></div>
      <div><dt>{t("colRecipient")}</dt><dd className="mono">{p.pay_to || "—"}</dd></div>
      <div><dt>{t("colAmount")}</dt><dd>{formatUsdc(p.amount, { maxDecimals: 6 })} USDC</dd></div>
      <div><dt>{t("colChain")}</dt><dd>{chainLabel} <NetworkKindPill kind={p.network_kind} /><span className="mono dim bills-detail-secondary">{p.network}</span></dd></div>
      <div><dt>{t("asset")}</dt><dd className="mono">{p.asset || "—"}</dd></div>
      <div><dt>{t("colTx")}</dt><dd><TxLink txHash={p.tx_hash} mock={isMockPayment(p)} network={p.network} /><span className="mono bills-detail-secondary">{p.tx_hash ?? "—"}</span></dd></div>
      <div><dt>{t("paymentId")}</dt><dd className="mono">{p.id}</dd></div>
      {p.approval_id && <div><dt>{t("approvalId")}</dt><dd className="mono">{p.approval_id}</dd></div>}
      <div><dt>{t("paymentStatus")}</dt><dd>{t(p.status === "settled" ? "statusSettled" : p.status === "failed" ? "statusFailed" : p.status === "reserved" ? "statusReserved" : "statusUnknown")}{p.error_code && <span className="mono bills-detail-secondary">{p.error_code}</span>}</dd></div>
    </dl>
  );
}

function BillsRow({ payment: p, keyNames, chainLabels, onPickKey, showPurpose }: {
  payment: PaymentRow;
  keyNames: Map<string, string>;
  chainLabels: Map<string, string>;
  onPickKey?: (keyId: string) => void;
  showPurpose: boolean;
}) {
  const t = useT(billsStrings);
  const dateTime = useDateTime();
  const [expanded, setExpanded] = useState(false);
  const charged = chargedOf(p);
  const name = billKeyName(p, keyNames);
  const chainLabel = chainLabels.get(p.network) ?? p.network;
  const detailId = `bill-detail-${p.id}`;
  const chainMark = p.network.startsWith("solana:") ? "S" : p.network === "eip155:8453" || p.network === "eip155:84532" ? "B" : p.network === "eip155:143" || p.network === "eip155:10143" ? "M" : "·";
  return (
    <>
      <tr className={`bills-record ${charged === "maybe" ? "row-unknown" : ""}`} data-charged={charged}>
        <td data-label={t("colAmount")} className="bills-amount-cell"><span className="bills-row-amount num">{formatUsdc(p.amount, { maxDecimals: 6 })} <span>USDC</span></span></td>
        <td data-label={t("colKey")} className="bills-key"><span className="bills-agent"><span className="bills-agent-mark" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>{onPickKey ? <button type="button" className="linklike-btn" onClick={() => onPickKey(p.key_id)}>{name}</button> : <span>{name}</span>}</span></td>
        <td data-label={t("colPurpose")} className="bills-purpose">{!p.purpose ? <span className="dim">{t("purposeMissing")}</span> : showPurpose ? p.purpose : <span className="bills-hidden"><LockKeyhole size={12} aria-hidden />{t("purposeHidden")}</span>}</td>
        <td data-label={t("colTime")} className="bills-time"><time dateTime={p.created_at}>{dateTime(p.created_at)}</time></td>
        <td data-label={t("colChain")} className="bills-chain"><span className={`bills-chain-mark bills-chain-${chainMark.toLowerCase()}`} aria-hidden>{chainMark}</span><span className="bills-chain-name">{chainLabel}<NetworkKindPill kind={p.network_kind} /></span></td>
        <td data-label={t("colUrl")} className="bills-url">{p.host}</td>
        <td data-label={t("colCharged")} className="bills-status-cell">
          <span title={t(charged === "yes" ? "chargedYesHint" : charged === "no" ? "chargedNoHint" : "chargedMaybeHint")}>
            <span className={`bills-status bills-status-${charged}`}><span aria-hidden />{t(p.status === "reserved" ? "statusReserved" : charged === "yes" ? "chargedYes" : charged === "no" ? "chargedNo" : "chargedMaybe")}</span>
          </span>
          {charged === "maybe" && <span className="bills-pending-hint">{t("pendingShortHint")}</span>}
        </td>
        <td data-label={t("colDetails")} className="bills-detail-cell"><button type="button" className="bills-detail-button" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={() => setExpanded(!expanded)}>{t(expanded ? "hideDetails" : "showDetails")}<ChevronDown size={13} aria-hidden /></button></td>
      </tr>
      {expanded && <tr className="bills-detail-row"><td colSpan={8} id={detailId}><BillsPaymentDetails payment={p} keyName={name} chainLabel={chainLabel} showPurpose={showPurpose} /></td></tr>}
    </>
  );
}

/** One row per payment; the overview includes only the request host, with private audit details available on demand. */
export function BillsTable({
  payments,
  keyNames,
  chainLabels,
  onPickKey,
  showPurpose = false,
}: {
  payments: PaymentRow[];
  keyNames: Map<string, string>;
  /** CAIP-2 → display name of the chain. */
  chainLabels: Map<string, string>;
  onPickKey?: (keyId: string) => void;
  showPurpose?: boolean;
}) {
  const t = useT(billsStrings);
  return (
    <table className="bills-table">
      <thead>
        <tr>
          <th>{t("colAmount")}</th>
          <th>{t("colKey")}</th>
          <th>{t("colPurpose")}</th>
          <th>{t("colTime")}</th>
          <th>{t("colChain")}</th>
          <th>{t("colUrl")}</th>
          <th>{t("colCharged")}</th>
          <th>{t("colDetails")}</th>
        </tr>
      </thead>
      <tbody>
        {payments.map((p) => <BillsRow key={p.id} payment={p} keyNames={keyNames} chainLabels={chainLabels} onPickKey={onPickKey} showPurpose={showPurpose} />)}
      </tbody>
    </table>
  );
}

/** All / Mainnet / Testnet. */
export function BillsKindFilter({ value, onChange }: { value: KindFilter; onChange: (kind: KindFilter) => void }) {
  const t = useT(billsStrings);
  const tc = useT(common);
  return (
    <div className="segmented" role="group" aria-label={t("kindFilterLabel")} data-testid="kind-filter">
      {KIND_OPTIONS.map((opt) => (
        <button key={opt} type="button" className={value === opt ? "active" : ""} data-kind-filter={opt} onClick={() => onChange(opt)}>
          {opt === "all" ? t("kindAny") : tc(opt === "mainnet" ? "kindMainnet" : "kindTestnet")}
        </button>
      ))}
    </div>
  );
}

/** The summary covers the current key/date/network scope; status tabs only change the records below. */
export function BillsSummary({ payments, onReview }: { payments: PaymentRow[]; onReview?: () => void }) {
  const t = useT(billsStrings);
  const tc = useT(common);
  const totals = useMemo(() => billsTotalsByKind(payments), [payments]);
  const pendingTotals = useMemo(() => billsPendingTotalsByKind(payments), [payments]);
  const maybeCount = payments.filter((p) => chargedOf(p) === "maybe").length;
  const settledCount = payments.filter((p) => chargedOf(p) === "yes").length;
  const failedCount = payments.filter((p) => chargedOf(p) === "no").length;
  return (
    <section className="bills-overview" aria-label={t("overviewLabel")}>
      <div className="bills-summary">
      {(totals.length > 0 ? totals : [{ kind: null, total: "0" }]).map((s) => (
        <article key={s.kind ?? "none"} className={`bills-total-card bills-total-${s.kind ?? "none"}`} data-total-kind={s.kind ?? undefined}>
          <div className="bills-total-header"><span className="bills-total-label">
            {t(s.kind === "mainnet" ? "summaryTotalMainnet" : s.kind === "testnet" ? "summaryTotalTestnet" : s.kind === "other" ? "summaryTotalOther" : "summaryTotal")}
          </span><ArrowUpRight size={17} aria-hidden /></div>
          <div className="bills-total-amount num">{formatUsdc(s.total, { maxDecimals: 6 })} <span>{tc("usdc")}</span></div>
          <p className="bills-total-caption">{t(s.kind === "mainnet" ? "realMoneyHint" : s.kind === "testnet" ? "testMoneyHint" : "confirmedOnlyHint")}</p>
        </article>
      ))}
      </div>
      <div className="bills-counts"><span>{t("summaryCount")} <strong>{payments.length}</strong></span><span>{t("chargedYes")} <strong>{settledCount}</strong></span><span>{t("chargedNo")} <strong>{failedCount}</strong></span><span>{t("summaryMaybe")} <strong>{maybeCount}</strong></span></div>
      {maybeCount > 0 && <div className="bills-review" data-testid="pending-summary">
        <span className="bills-review-icon"><Clock3 size={19} aria-hidden /></span>
        <div className="bills-review-copy"><strong>{t("reviewTitle", { count: maybeCount })}</strong><p>{t("reviewHint")}</p><div className="bills-pending-totals">{pendingTotals.map((s) => <span key={s.kind} data-pending-kind={s.kind}>{s.kind === "mainnet" ? tc("kindMainnet") : s.kind === "testnet" ? tc("kindTestnet") : t("otherNetworks")} <strong className="num">{formatUsdc(s.total, { maxDecimals: 6 })} USDC</strong></span>)}</div></div>
        {onReview && <button type="button" className="bills-review-button" onClick={onReview}>{t("reviewAction")}<ArrowUpRight size={14} aria-hidden /></button>}
      </div>}
    </section>
  );
}

export function BillsStatusFilter({ value, payments, onChange }: { value: ChargedFilter; payments: PaymentRow[]; onChange: (value: ChargedFilter) => void }) {
  const t = useT(billsStrings);
  return <div className="bills-status-tabs" role="group" aria-label={t("colCharged")}>{CHARGED_OPTIONS.map((opt) => <button key={opt} type="button" className={value === opt ? "active" : ""} aria-pressed={value === opt} data-status-filter={opt} onClick={() => onChange(opt)}>{t(opt === "all" ? "chargedAny" : opt === "yes" ? "chargedYes" : opt === "no" ? "chargedNo" : "chargedMaybe")}<span>{opt === "all" ? payments.length : payments.filter((p) => chargedOf(p) === opt).length}</span></button>)}</div>;
}

/** Said whenever the server held more payments than it sent: the list, the totals and the CSV then cover only the newest ones. */
export function BillsTruncation({ bills }: { bills: BillsList | null | undefined }) {
  const t = useT(billsStrings);
  if (!bills?.truncated) return null;
  return <Callout tone="warn">{t("truncatedNotice", { shown: bills.payments.length, total: bills.total })}</Callout>;
}

/**
 * The most rows the table draws at once. The server may send up to 10,000 payments and the page re-renders on every poll (the keys list
 * is polled every 3 s) and every keystroke in the search box, so drawing them all would freeze the tab. The count, the total and the
 * CSV still cover every match.
 */
export const BILLS_RENDER_ROWS = 500;

/** The newest `max` of the (newest-first) matching payments: what the table draws. */
export function visibleBills(matching: PaymentRow[], max: number = BILLS_RENDER_ROWS): PaymentRow[] {
  return matching.length > max ? matching.slice(0, max) : matching;
}

/** Said whenever the table draws fewer rows than match: the count, the total and the CSV cover all of them. */
export function BillsRenderCap({ shown, matching }: { shown: number; matching: number }) {
  const t = useT(billsStrings);
  if (shown >= matching) return null;
  return <Callout tone="info">{t("renderCapNotice", { shown, matching })}</Callout>;
}

/** Keep existing CSV columns stable. Private request paths and caller purposes require an explicit export choice. */
export function billsCsv(payments: PaymentRow[], keyNames: Map<string, string>, includePrivateDetails = false): string {
  const headers = ["time", "key_id", "key_name", "host", "url", "network", "amount", "charged", "tx_hash", "error_code", "pay_to", "method", "approval_id", "network_kind", "purpose", "asset", "status"];
  const rows = payments.map((p) => [
    p.created_at,
    p.key_id,
    p.key_name || keyNames.get(p.key_id) || "",
    p.host,
    includePrivateDetails ? p.url : "",
    p.network,
    p.amount,
    chargedOf(p),
    p.tx_hash ?? "",
    p.error_code ?? "",
    p.pay_to,
    p.method,
    p.approval_id ?? "",
    p.network_kind ?? "",
    includePrivateDetails ? p.purpose ?? "" : "",
    p.asset,
    p.status,
  ]);
  return toCsv(headers, rows);
}

export default function BillsPage() {
  const t = useT(billsStrings);
  const tc = useT(common);
  const meta = useAdminMeta();
  // The bills answer is big (every payment, up to 10,000 of them), so it is fetched every 15 s; the keys list stays on the default 3 s.
  const { data: bills, error, loading } = usePolling(listBills, 15000);
  const payments = bills?.payments;
  const { data: keys } = usePolling(listKeys);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showPurpose, setShowPurpose] = useState(false);
  const [includePrivateExport, setIncludePrivateExport] = useState(false);

  const keyFilter = searchParams.get("key") ?? "all";
  const chargedFilter = (searchParams.get("charged") as ChargedFilter) ?? "all";
  const range = (searchParams.get("range") as RangeFilter) ?? "7d";
  const kindFilter = (searchParams.get("network") as KindFilter) ?? "all";
  const q = searchParams.get("q") ?? "";

  function updateParam(name: string, value: string, defaultValue: string) {
    const next = new URLSearchParams(searchParams);
    if (value === defaultValue) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  }

  const keyNames = useMemo(() => new Map((keys ?? []).map((k: MoneyKeyRow) => [k.id, k.name] as const)), [keys]);
  const chainLabels = useMemo(() => new Map((meta?.networks ?? []).map((n) => [n.network, n.network_label] as const)), [meta]);

  const scopePayments = useMemo(() => {
    if (!payments) return [];
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    return payments.filter((p) => {
      if (keyFilter !== "all" && p.key_id !== keyFilter) return false;
      if (!kindMatches(p, kindFilter)) return false;
      if (!withinRange(p.created_at, range, now)) return false;
      if (needle) {
        const haystack = [p.tx_hash, p.url, p.host, p.id, p.pay_to, billKeyName(p, keyNames), ...(showPurpose ? [p.purpose] : [])].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [payments, keyNames, showPurpose, keyFilter, kindFilter, range, q]);

  const filtered = useMemo(() => scopePayments.filter((p) => chargedFilter === "all" || chargedOf(p) === chargedFilter), [scopePayments, chargedFilter]);

  const visible = useMemo(() => visibleBills(filtered), [filtered]);

  const hasActiveFilters = keyFilter !== "all" || chargedFilter !== "all" || kindFilter !== "all" || range !== "7d" || q !== "";

  function clearFilters() {
    setSearchParams({}, { replace: true });
  }

  function exportCsv() {
    downloadCsv(`moneyswitch-bills-${new Date().toISOString().slice(0, 10)}.csv`, billsCsv(filtered, keyNames, includePrivateExport));
  }

  return (
    <div className="bills-page">
      <div className="bills-page-header">
        <div><span className="bills-eyebrow">{t("ledgerEyebrow")}</span><h2>{t("ledgerTitle")}</h2><p>{t("ledgerIntro")}</p></div>
        <div className="bills-export">
          <button className="btn secondary" onClick={exportCsv} disabled={filtered.length === 0}><Download size={15} aria-hidden />{t("exportCsv")}</button>
          <details className="bills-export-options"><summary>{t("exportOptions")}<ChevronDown size={12} aria-hidden /></summary><label className="bills-checkbox"><input type="checkbox" checked={includePrivateExport} onChange={(e) => setIncludePrivateExport(e.target.checked)} />{t("exportPrivate")}</label></details>
        </div>
      </div>

      {error && <div className="error-banner">{tc("requestFailed", { message: error })}</div>}
      <BillsTruncation bills={bills} />
      <BillsSummary payments={scopePayments} onReview={() => updateParam("charged", "maybe", "all")} />
      <p className="bills-scope-hint">{t("summaryScopeHint")}</p>

      <div className="bills-filter-panel">
        <BillsStatusFilter value={chargedFilter} payments={scopePayments} onChange={(value) => updateParam("charged", value, "all")} />
        <div className="filters bills-filters">
          <select aria-label={t("colKey")} value={keyFilter} onChange={(e) => updateParam("key", e.target.value, "all")}>
            <option value="all">{t("allKeys")}</option>
            {(keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <BillsKindFilter value={kindFilter} onChange={(kind) => updateParam("network", kind, "all")} />
          <select aria-label={t("rangeFilterLabel")} value={range} onChange={(e) => updateParam("range", e.target.value, "7d")}>
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {t(opt === "today" ? "rangeToday" : opt === "24h" ? "range24h" : opt === "7d" ? "range7d" : "rangeAll")}
              </option>
            ))}
          </select>
          <label className="search-input">
            <Search size={13} aria-hidden />
            <input type="text" aria-label={t("searchPlaceholder")} value={q} placeholder={t("searchPlaceholder")} onChange={(e) => updateParam("q", e.target.value, "")} />
          </label>
          {hasActiveFilters && (
            <button type="button" className="btn secondary small" onClick={clearFilters}>
              {t("clearFilters")}
            </button>
          )}
        </div>
      </div>

      <section className="card bills-ledger">
        <div className="bills-ledger-header"><div><h3>{t("activityTitle")}</h3><span>{t("recordsCount", { count: filtered.length })}</span></div><label className="bills-checkbox"><input type="checkbox" checked={showPurpose} onChange={(e) => setShowPurpose(e.target.checked)} /><LockKeyhole size={13} aria-hidden />{t("showPurposes")}</label></div>
        {loading && !payments ? (
          <SkeletonTable rows={6} cols={8} />
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
          <>
            <BillsRenderCap shown={visible.length} matching={filtered.length} />
            <div className="bills-table-wrap"><BillsTable payments={visible} keyNames={keyNames} chainLabels={chainLabels} showPurpose={showPurpose} onPickKey={(id) => updateParam("key", id, "all")} /></div>
          </>
        )}
        <div className="bills-ledger-footer"><span><ShieldCheck size={13} aria-hidden />{t("overviewPrivacyShort")}</span><details className="bills-privacy-explanation"><summary>{t("privacyDetails")}<ChevronDown size={12} aria-hidden /></summary><p>{t("privacyHint")}</p><p>{t("purposeHint")}</p></details></div>
      </section>
    </div>
  );
}
