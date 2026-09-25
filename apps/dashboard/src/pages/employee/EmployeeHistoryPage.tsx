import React, { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useAuth } from "../../auth";
import { usePolling } from "../../usePolling";
import { getHistory, HistoryRow } from "../../api";
import { formatUsdc, sumDecimalStrings, toCsv, downloadCsv, urlPath } from "../../money";
import Pill from "../../components/Pill";
import { SkeletonTable } from "../../components/Skeleton";

const EXPLORER_TX_BASE = "https://testnet.monadvision.com/tx/";

export default function EmployeeHistoryPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey as string;
  const { data: history, error, loading } = usePolling(() => getHistory(key));
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    if (!history) return [];
    if (statusFilter === "all") return history;
    return history.filter((h) => h.status === statusFilter);
  }, [history, statusFilter]);

  const total = sumDecimalStrings(filtered.map((h) => h.amount));

  function exportCsv() {
    const headers = ["时间", "类型", "模型或URL", "金额", "状态", "tx_hash", "错误码"];
    const rows = filtered.map((h) => [h.created_at, h.kind, h.kind === "chat" ? h.model ?? "" : h.url, h.amount, h.status, h.tx_hash ?? "", h.error_code ?? ""]);
    downloadCsv(`我的流水-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
  }

  return (
    <div>
      <div className="toolbar">
        <div className="filters">
          <div className="segmented">
            {[
              { value: "all", label: "全部状态" },
              { value: "settled", label: "已结算" },
              { value: "reserved", label: "处理中" },
              { value: "failed", label: "失败" },
              { value: "unknown", label: "未知" },
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
        </div>
        <button className="btn secondary" onClick={exportCsv} disabled={filtered.length === 0}>
          <Download size={14} />
          导出 CSV
        </button>
      </div>

      {error && <div className="error-banner">出错了：{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 32 }}>
          <div>
            <div className="stat-label">笔数</div>
            <div className="stat-value num">{filtered.length}</div>
          </div>
          <div>
            <div className="stat-label">合计</div>
            <div className="stat-value num">{formatUsdc(total, { maxDecimals: 4 })} USDC</div>
          </div>
        </div>
      </div>

      <div className="card">
        {loading && !history ? (
          <SkeletonTable rows={6} cols={6} />
        ) : filtered.length === 0 ? (
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
                <th>交易</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((h: HistoryRow) => (
                <tr key={h.id} className={h.status === "unknown" ? "row-unknown" : ""}>
                  <td>{new Date(h.created_at).toLocaleString()}</td>
                  <td>
                    <Pill tone={h.kind === "chat" ? "blue" : "gray"}>{h.kind === "chat" ? "对话" : "调用"}</Pill>
                  </td>
                  <td className="mono" style={{ maxWidth: 260, whiteSpace: "normal", wordBreak: "break-all" }}>
                    {h.kind === "chat" ? h.model ?? "-" : urlPath(h.url) || h.url}
                  </td>
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
                  <td>
                    {h.tx_hash ? (
                      h.tx_hash.startsWith("0xmock") ? (
                        <span className="mono">{h.tx_hash.slice(0, 10)}…</span>
                      ) : (
                        <a href={EXPLORER_TX_BASE + h.tx_hash} target="_blank" rel="noreferrer">
                          {h.tx_hash.slice(0, 10)}…
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
