import React, { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { usePolling } from "../usePolling";
import { listUsage, listKeys, isMockPayment, PaymentRow } from "../api";
import { formatUsdc, sumDecimalStrings, toCsv, downloadCsv, urlPath } from "../money";
import Pill from "../components/Pill";
import { SkeletonTable } from "../components/Skeleton";

const EXPLORER_TX_BASE = "https://testnet.monadvision.com/tx/";

type RangeFilter = "24h" | "7d" | "all";

function withinRange(iso: string, range: RangeFilter, now: number): boolean {
  if (range === "all") return true;
  const ms = range === "24h" ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  return now - new Date(iso).getTime() <= ms;
}

export default function UsagePage() {
  const { data: payments, error, loading } = usePolling(listUsage);
  const { data: keys } = usePolling(listKeys);
  const [keyFilter, setKeyFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [range, setRange] = useState<RangeFilter>("7d");

  const keyById = useMemo(() => new Map((keys ?? []).map((k) => [k.id, k] as const)), [keys]);

  const filtered = useMemo(() => {
    if (!payments) return [];
    const now = Date.now();
    return payments.filter((p) => {
      if (keyFilter !== "all" && p.key_id !== keyFilter) return false;
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!withinRange(p.created_at, range, now)) return false;
      return true;
    });
  }, [payments, keyFilter, statusFilter, range]);

  const totalAmount = sumDecimalStrings(filtered.map((p) => p.amount));

  function exportCsv() {
    const headers = [
      "time",
      "key_id",
      "key_name",
      "type",
      "model",
      "host",
      "method",
      "amount",
      "status",
      "tokens",
      "mock",
      "tx_hash",
      "error_code",
    ];
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
          <select value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)}>
            <option value="all">All keys</option>
            {(keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <div className="segmented">
            {[
              { value: "all", label: "All statuses" },
              { value: "settled", label: "Settled" },
              { value: "reserved", label: "Reserved" },
              { value: "failed", label: "Failed" },
              { value: "unknown", label: "Unknown" },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={statusFilter === opt.value ? "active" : ""}
                onClick={() => setStatusFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <select value={range} onChange={(e) => setRange(e.target.value as RangeFilter)}>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7d</option>
            <option value="all">All time</option>
          </select>
        </div>
        <button className="btn secondary" onClick={exportCsv} disabled={filtered.length === 0}>
          <Download size={14} />
          Export CSV
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 32 }}>
          <div>
            <div className="stat-label">Payments</div>
            <div className="stat-value num">{filtered.length}</div>
          </div>
          <div>
            <div className="stat-label">Total amount</div>
            <div className="stat-value num">{formatUsdc(totalAmount, { maxDecimals: 4 })} USDC</div>
          </div>
        </div>
      </div>

      <div className="card">
        {loading && !payments ? (
          <SkeletonTable rows={6} cols={9} />
        ) : filtered.length === 0 ? (
          <div className="empty-state">No payments match these filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Key</th>
                <th>Type</th>
                <th>Model</th>
                <th>Host / model</th>
                <th className="num">Amount</th>
                <th className="num">Tokens</th>
                <th>Status</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p: PaymentRow) => (
                <tr key={p.id} className={p.status === "unknown" ? "row-unknown" : ""}>
                  <td>{new Date(p.created_at).toLocaleString()}</td>
                  <td>{keyById.get(p.key_id)?.name ?? <span className="mono">{p.key_id.slice(0, 8)}</span>}</td>
                  <td>
                    <Pill tone={p.kind === "chat" ? "blue" : "gray"}>{p.kind ?? "fetch"}</Pill>
                  </td>
                  <td className="mono">{p.model ?? "-"}</td>
                  <td className="mono" style={{ maxWidth: 260, whiteSpace: "normal", wordBreak: "break-all" }}>
                    {p.kind === "chat" ? p.model ?? "-" : `${p.host}${urlPath(p.url)}`}
                  </td>
                  <td className="num">{formatUsdc(p.amount, { maxDecimals: 4 })}</td>
                  <td className="num">{p.prompt_tokens != null || p.completion_tokens != null ? (p.prompt_tokens ?? 0) + (p.completion_tokens ?? 0) : "-"}</td>
                  <td>
                    <Pill tone={p.status === "settled" ? "green" : p.status === "failed" ? "red" : p.status === "reserved" ? "blue" : "yellow"}>
                      {p.status}
                    </Pill>
                    {isMockPayment(p) && (
                      <span className="badge mock" style={{ marginLeft: 6 }}>
                        MOCK
                      </span>
                    )}
                  </td>
                  <td>
                    {p.tx_hash ? (
                      isMockPayment(p) ? (
                        <span className="mono">{p.tx_hash.slice(0, 10)}…</span>
                      ) : (
                        <a href={EXPLORER_TX_BASE + p.tx_hash} target="_blank" rel="noreferrer">
                          {p.tx_hash.slice(0, 10)}…
                        </a>
                      )
                    ) : (
                      "-"
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
