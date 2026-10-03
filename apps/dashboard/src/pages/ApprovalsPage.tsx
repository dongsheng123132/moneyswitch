import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, Check, X } from "lucide-react";
import { usePolling } from "../usePolling";
import { listApprovals, approveApproval, denyApproval, listKeys, ApiError, ApprovalRow } from "../api";
import { formatUsdc, shortAddr } from "../money";
import { SkeletonBlock } from "../components/Skeleton";
import Avatar from "../components/Avatar";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import Pill from "../components/Pill";
import Term from "../components/Term";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { approvalsStrings } from "../i18n/strings/approvals";
import { useRelativeTime } from "../i18n/format";
import "../styles/approvals.css";

const DECIDED_STATUS_KEY: Record<string, "statusApproved" | "statusDenied" | "statusExpired" | "statusUsed"> = {
  approved: "statusApproved",
  denied: "statusDenied",
  expired: "statusExpired",
  used: "statusUsed",
};

const DECIDED_TONE: Record<string, "green" | "red" | "gray" | "blue"> = {
  approved: "green",
  denied: "red",
  expired: "gray",
  used: "blue",
};

export default function ApprovalsPage() {
  const t = useT(approvalsStrings);
  const tc = useT(common);
  const relTime = useRelativeTime();
  const { data: approvals, error, loading, refresh } = usePolling(() => listApprovals("pending"));
  const { data: decided } = usePolling(() => listApprovals());
  const { data: keys } = usePolling(listKeys);
  const keyById = useMemo(() => new Map((keys ?? []).map((k) => [k.id, k] as const)), [keys]);
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<{ id: string; kind: "approved" | "denied" } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!successMsg) return;
    const id = setTimeout(() => setSuccessMsg(null), 4000);
    return () => clearTimeout(id);
  }, [successMsg]);

  function countdown(expiresAt: string): string {
    const diffMs = new Date(expiresAt).getTime() - Date.now();
    if (diffMs <= 0) return t("countdownExpired");
    const totalSec = Math.floor(diffMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return t("countdownLeft", { m: min, s: sec.toString().padStart(2, "0") });
  }

  async function act(id: string, action: "approve" | "deny") {
    setActingId(id);
    setActionError(null);
    try {
      if (action === "approve") await approveApproval(id);
      else await denyApproval(id);
      setSuccessMsg({ id, kind: action === "approve" ? "approved" : "denied" });
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : `${action}_failed`);
    } finally {
      setActingId(null);
    }
  }

  const recentlyDecided = (decided ?? [])
    .filter((a) => a.status !== "pending")
    .sort((a, b) => new Date(b.decided_at ?? b.created_at).getTime() - new Date(a.decided_at ?? a.created_at).getTime())
    .slice(0, 10);

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
      <Callout tone="info" title={t("introTitle")}>
        {t("introBody")}
      </Callout>

      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}
      {actionError && <Callout tone="error">{actionError}</Callout>}
      {/* Page-level confirmation: the decided card leaves the pending list on the next poll, so feedback must not live only inside it. */}
      {successMsg && !approvals?.some((a) => a.id === successMsg.id) && (
        <Callout tone="success">{successMsg.kind === "approved" ? t("successApproved") : t("successDenied")}</Callout>
      )}

      {!approvals || approvals.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<ShieldCheck size={28} />}
            title={t("emptyTitle")}
            action={
              <Link className="btn small" to="/keys">
                {t("emptyAction")}
              </Link>
            }
          >
            {t("emptyBody")}
          </EmptyState>
        </div>
      ) : (
        <div className="approval-grid">
          {approvals.map((a) => {
            const key = keyById.get(a.key_id);
            const keyLabel = key?.name ?? a.key_id.slice(0, 8);
            const showSuccess = successMsg?.id === a.id;
            return (
              <div className="approval-card" key={a.id}>
                <div className="approval-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar name={keyLabel} size={22} />
                  <span className={key ? undefined : "mono"}>{keyLabel}</span>
                </div>
                <div className="approval-amount num">
                  {formatUsdc(a.amount, { maxDecimals: 4 })} {tc("usdc")}
                </div>
                <div className="approval-url">{a.url}</div>
                <div className="approval-meta">
                  <span>{t("payTo", { addr: shortAddr(a.pay_to) })}</span>
                  <span>{countdown(a.expires_at)}</span>
                </div>
                {key && (
                  <div className="approval-key-context">
                    <div>{t("keyContextUsed", { used: formatUsdc(key.used_today, { maxDecimals: 4 }), daily: formatUsdc(key.daily_budget, { maxDecimals: 4 }) })}</div>
                    <div>
                      <Term k="approvalThreshold">{t("keyContextThreshold")}</Term>: {key.approval_threshold != null ? formatUsdc(key.approval_threshold, { maxDecimals: 4 }) : tc("none")}
                    </div>
                    <div>
                      <Term k="perRequestLimit">{t("keyContextPerRequest")}</Term>: {formatUsdc(key.per_request_limit, { maxDecimals: 4 })}
                    </div>
                  </div>
                )}

                {showSuccess ? (
                  <Callout tone="success">{successMsg?.kind === "approved" ? t("successApproved") : t("successDenied")}</Callout>
                ) : (
                  <div className="approval-actions">
                    <button className="btn danger" disabled={actingId === a.id} onClick={() => act(a.id, "deny")}>
                      <X size={14} />
                      {t("deny")}
                    </button>
                    <button className="btn success" disabled={actingId === a.id} onClick={() => act(a.id, "approve")}>
                      <Check size={14} />
                      {t("approve")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {recentlyDecided.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3>{t("recentDecidedTitle")}</h3>
          </div>
          <div className="decided-list">
            {recentlyDecided.map((a) => {
              const key = keyById.get(a.key_id);
              const keyLabel = key?.name ?? a.key_id.slice(0, 8);
              const statusKey = DECIDED_STATUS_KEY[a.status] ?? "statusExpired";
              const tone = DECIDED_TONE[a.status] ?? "gray";
              return (
                <div className="decided-row" key={a.id}>
                  <Avatar name={keyLabel} size={20} />
                  <span className={key ? undefined : "mono"} style={{ flexShrink: 0 }}>
                    {keyLabel}
                  </span>
                  <span className="num">{formatUsdc(a.amount, { maxDecimals: 4 })}</span>
                  <Pill tone={tone}>{t(statusKey)}</Pill>
                  <span className="dim" style={{ marginLeft: "auto" }}>
                    {relTime(a.decided_at ?? a.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
