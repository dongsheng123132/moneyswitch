import React, { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Check, X } from "lucide-react";
import { usePolling } from "../usePolling";
import { listApprovals, approveApproval, denyApproval, listKeys, ApiError } from "../api";
import { formatUsdc, formatCountdown, shortAddr } from "../money";
import { SkeletonBlock } from "../components/Skeleton";
import Avatar from "../components/Avatar";

export default function ApprovalsPage() {
  const { data: approvals, error, loading, refresh } = usePolling(() => listApprovals("pending"));
  const { data: keys } = usePolling(listKeys);
  const keyById = useMemo(() => new Map((keys ?? []).map((k) => [k.id, k] as const)), [keys]);
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function act(id: string, action: "approve" | "deny") {
    setActingId(id);
    setActionError(null);
    try {
      if (action === "approve") await approveApproval(id);
      else await denyApproval(id);
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : `${action}_failed`);
    } finally {
      setActingId(null);
    }
  }

  if (loading && !approvals) {
    return (
      <div className="approval-grid">
        <div className="approval-card">
          <SkeletonBlock height={16} width={180} />
          <div style={{ height: 10 }} />
          <SkeletonBlock height={12} width={240} />
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}
      {!approvals || approvals.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">
              <ShieldCheck size={28} />
            </div>
            <div className="empty-title">No pending approvals</div>
            agents are within budget
          </div>
        </div>
      ) : (
        <div className="approval-grid">
          {approvals.map((a) => {
            const key = keyById.get(a.key_id);
            const keyLabel = key?.name ?? a.key_id.slice(0, 8);
            return (
            <div className="approval-card" key={a.id}>
              <div className="approval-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Avatar name={keyLabel} size={22} />
                <span>
                  <span className={key ? undefined : "mono"}>{keyLabel}</span> wants to spend{" "}
                  <span className="num">{formatUsdc(a.amount, { maxDecimals: 4 })}</span> USDC
                </span>
              </div>
              <div className="approval-url">{a.url}</div>
              <div className="approval-meta">
                <span>
                  pay to <span className="mono">{shortAddr(a.pay_to)}</span>
                </span>
                <span>{formatCountdown(a.expires_at)}</span>
              </div>
              <div className="approval-actions">
                <button className="btn danger" disabled={actingId === a.id} onClick={() => act(a.id, "deny")}>
                  <X size={14} />
                  Deny
                </button>
                <button className="btn success" disabled={actingId === a.id} onClick={() => act(a.id, "approve")}>
                  <Check size={14} />
                  Approve
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
